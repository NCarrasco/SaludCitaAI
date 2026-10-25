#!/usr/bin/env bash
# Copia de seguridad cifrada de SaludCita AI:
#   - base de la aplicación y base de n8n (pg_dump, formato custom)
#   - .env de la instancia (contiene N8N_ENCRYPTION_KEY y los secretos necesarios para restaurar)
#   - manifiesto con versiones, conteos y sumas SHA-256
# Cifrado: AES-256-CBC + PBKDF2 (openssl) con la frase de BACKUP_PASSPHRASE (no se guarda en ningún archivo).
#
# Uso:  BACKUP_PASSPHRASE='…' ./scripts/backup.sh [--pause-writers] [directorio-destino]   (por defecto: ./backups, ignorado por Git)
#   --pause-writers  detiene n8n (planificador y conversación) durante el volcado para que los conteos del manifiesto
#                    coincidan exactamente con lo volcado; útil para verificar restauraciones. Sin él, la copia es
#                    consistente por base (pg_dump usa una instantánea) pero los conteos pueden variar por escrituras simultáneas.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BACKUP_PASSPHRASE:?Define BACKUP_PASSPHRASE en el entorno (no se guarda en archivos)}"
[[ ${#BACKUP_PASSPHRASE} -ge 12 ]] || { echo "BACKUP_PASSPHRASE debe tener al menos 12 caracteres" >&2; exit 1; }
set -a; source .env; set +a
PAUSE=0
if [[ "${1:-}" == "--pause-writers" ]]; then PAUSE=1; shift; fi
DEST="${1:-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
dc() { docker compose --env-file .env -f infra/compose.yaml "$@"; }
psqlq() { dc exec -T postgres psql -U postgres -d "$1" -tAc "$2"; }

if [[ $PAUSE == 1 ]]; then
  echo "Deteniendo n8n durante la copia…"; dc stop n8n >/dev/null
  trap 'rm -rf "$WORK"; dc start n8n >/dev/null && echo "n8n reanudado."' EXIT
fi
echo "Volcando bases (${APP_DB_NAME}, ${N8N_DB_NAME})…"
dc exec -T postgres pg_dump -U "$APP_DB_USER" -d "$APP_DB_NAME" -Fc --no-acl > "$WORK/app.dump"
dc exec -T postgres pg_dump -U "$N8N_DB_USER" -d "$N8N_DB_NAME" -Fc --no-acl > "$WORK/n8n.dump"
cp .env "$WORK/instance.env"

count() { psqlq "$APP_DB_NAME" "SELECT count(*) FROM $1"; }
cat > "$WORK/manifest.json" <<JSON
{
  "created_at": "$STAMP",
  "project": "${COMPOSE_PROJECT_NAME:-saludcita}",
  "postgres": "$(psqlq postgres 'SHOW server_version')",
  "app_migrations": "$(psqlq "$APP_DB_NAME" "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")",
  "counts": {
    "appointments": $(count appointments), "appointment_events": $(count appointment_events), "patients": $(count patients),
    "patient_accounts": $(count patient_accounts), "admin_users": $(count admin_users), "notifications": $(count notifications),
    "advance_offers": $(count advance_offers), "outbox_jobs_pending": $(psqlq "$APP_DB_NAME" "SELECT count(*) FROM outbox_jobs WHERE status IN ('pending','leased')"),
    "offers_pending": $(psqlq "$APP_DB_NAME" "SELECT count(*) FROM advance_offers WHERE status = 'pending'"),
    "admin_audit_log": $(count admin_audit_log), "messages": $(count messages),
    "n8n_workflows": $(psqlq "$N8N_DB_NAME" "SELECT count(*) FROM workflow_entity"),
    "n8n_credentials": $(psqlq "$N8N_DB_NAME" "SELECT count(*) FROM credentials_entity"),
    "n8n_executions": $(psqlq "$N8N_DB_NAME" "SELECT count(*) FROM execution_entity")
  },
  "sha256": {
    "app.dump": "$(shasum -a 256 "$WORK/app.dump" | cut -d' ' -f1)",
    "n8n.dump": "$(shasum -a 256 "$WORK/n8n.dump" | cut -d' ' -f1)"
  }
}
JSON
mkdir -p "$DEST"
OUT="$DEST/saludcita-backup-$STAMP.tar.enc"
tar -C "$WORK" -cf - app.dump n8n.dump instance.env manifest.json \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT"
shasum -a 256 "$OUT" > "$OUT.sha256"
chmod 600 "$OUT"
echo "Copia creada: $OUT ($(du -h "$OUT" | cut -f1)). Guárdala FUERA del servidor junto con su .sha256; la frase no se guarda."
echo "Conteos:"; sed -n '/"counts"/,/}/p' "$WORK/manifest.json"
