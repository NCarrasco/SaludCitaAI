#!/usr/bin/env bash
# Restaura una copia cifrada en un ENTORNO SEPARADO (otro proyecto Compose, volúmenes y puertos nuevos).
# Nunca toca la instancia de origen: rechaza un nombre de proyecto que ya tenga volúmenes.
#
# Uso:  BACKUP_PASSPHRASE='…' ./scripts/restore.sh <copia.tar.enc> <nombre-proyecto-destino> <desplazamiento-de-puertos>
# Ej.:  BACKUP_PASSPHRASE='…' ./scripts/restore.sh backups/saludcita-backup-…tar.enc saludcita-restaurada 10000
#       → API en 18080, Gradio en 17860, n8n en 15678, PostgreSQL en 65433 (solo 127.0.0.1)
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?ruta de la copia}"; PROJECT="${2:?nombre del proyecto destino}"; OFFSET="${3:?desplazamiento de puertos}"
: "${BACKUP_PASSPHRASE:?Define BACKUP_PASSPHRASE}"
[[ -f "$FILE.sha256" ]] && shasum -a 256 -c "$FILE.sha256"
if docker volume ls --format '{{.Name}}' | grep -q "^${PROJECT}_"; then
  echo "El proyecto '$PROJECT' ya tiene volúmenes: elige otro nombre (no se sobrescribe nada)." >&2; exit 1
fi
RDIR="restores/$PROJECT"; mkdir -p "$RDIR"; chmod 700 "$RDIR"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" | tar -C "$RDIR" -xf -
( cd "$RDIR" && for f in app.dump n8n.dump; do
    want=$(python3 -c "import json;print(json.load(open('manifest.json'))['sha256']['$f'])")
    got=$(shasum -a 256 "$f" | cut -d' ' -f1); [[ "$want" == "$got" ]] || { echo "Suma SHA-256 distinta en $f" >&2; exit 1; }
  done )

# .env del destino: mismos secretos (necesarios para credenciales de n8n y tokens hasheados), otro proyecto y otros puertos
ENV="$RDIR/.env"
python3 - "$RDIR/instance.env" "$ENV" "$PROJECT" "$OFFSET" <<'PY'
import re, sys
src, dst, project, off = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
defaults = {"POSTGRES_HOST_PORT": 55433, "API_HOST_PORT": 8080, "N8N_HOST_PORT": 5678, "GRADIO_HOST_PORT": 7860, "OLLAMA_HOST_PORT": 11434}
lines, seen = [], set()
for line in open(src):
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.rstrip("\n"))
    if m and m.group(1) in defaults:
        line = f"{m.group(1)}={int(m.group(2) or defaults[m.group(1)]) + off}\n"; seen.add(m.group(1))
    elif m and m.group(1) == "COMPOSE_PROJECT_NAME":
        line = f"COMPOSE_PROJECT_NAME={project}\n"; seen.add("COMPOSE_PROJECT_NAME")
    lines.append(line)
for k, v in defaults.items():
    if k not in seen: lines.append(f"{k}={v + off}\n")
if "COMPOSE_PROJECT_NAME" not in seen: lines.append(f"COMPOSE_PROJECT_NAME={project}\n")
open(dst, "w").writelines(lines)
PY
chmod 600 "$ENV"
set -a; source "$ENV"; set +a
dc() { docker compose --env-file "$ENV" -f infra/compose.yaml "$@"; }

echo "1/3 PostgreSQL vacío del entorno '$PROJECT' (roles y bases por el script de inicialización)…"
dc up -d postgres
for i in $(seq 1 60); do dc exec -T postgres pg_isready -U postgres -d "$APP_DB_NAME" >/dev/null 2>&1 && break; sleep 2; done
echo "2/3 Restaurando bases…"
dc exec -T postgres pg_restore -U "$APP_DB_USER" -d "$APP_DB_NAME" --no-owner --exit-on-error < "$RDIR/app.dump"
dc exec -T postgres pg_restore -U "$N8N_DB_USER" -d "$N8N_DB_NAME" --no-owner --exit-on-error < "$RDIR/n8n.dump"
echo "3/3 Restauración de datos terminada. Arranca el resto con:"
echo "    docker compose --env-file $ENV -f infra/compose.yaml up -d --build"
echo "y verifica con:  ./scripts/verify-restore.sh $RDIR"
