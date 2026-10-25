#!/usr/bin/env bash
# Compara una instancia restaurada con el manifiesto de la copia y comprueba que recupera trabajos.
# Uso: ./scripts/verify-restore.sh restores/<proyecto>
set -euo pipefail
cd "$(dirname "$0")/.."
RDIR="${1:?directorio de restauración}"; ENV="$RDIR/.env"
set -a; source "$ENV"; set +a
dc() { docker compose --env-file "$ENV" -f infra/compose.yaml "$@"; }
q() { dc exec -T postgres psql -U postgres -d "$1" -tAc "$2"; }
fail=0
cmp() { local name="$1" want="$2" got="$3"; if [[ "$want" == "$got" ]]; then echo "✔ $name: $got"; else echo "✘ $name: esperado $want, obtenido $got"; fail=1; fi; }
m() { python3 -c "import json;print(json.load(open('$RDIR/manifest.json'))['counts']['$1'])"; }
for t in appointments appointment_events patients patient_accounts admin_users notifications advance_offers admin_audit_log messages; do
  cmp "$t" "$(m $t)" "$(q "$APP_DB_NAME" "SELECT count(*) FROM $t")"
done
cmp "migraciones" "$(python3 -c "import json;print(json.load(open('$RDIR/manifest.json'))['app_migrations'])")" "$(q "$APP_DB_NAME" "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
cmp "n8n: workflows" "$(m n8n_workflows)" "$(q "$N8N_DB_NAME" "SELECT count(*) FROM workflow_entity")"
cmp "n8n: credenciales" "$(m n8n_credentials)" "$(q "$N8N_DB_NAME" "SELECT count(*) FROM credentials_entity")"
cmp "n8n: historial de ejecuciones" "$(m n8n_executions)" "$(q "$N8N_DB_NAME" "SELECT count(*) FROM execution_entity WHERE \"startedAt\" <= '$(python3 -c "import json,datetime;d=json.load(open('$RDIR/manifest.json'))['created_at'];print(datetime.datetime.strptime(d,'%Y%m%dT%H%M%SZ').strftime('%Y-%m-%d %H:%M:%S+00'))")'")"
echo "API: $(curl -s "http://127.0.0.1:${API_HOST_PORT}/api/v1/health/ready")"
exit $fail
