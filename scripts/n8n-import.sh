#!/bin/sh
# Importa credenciales (generadas desde variables de entorno, nunca desde Git) y workflows versionados,
# y publica los workflows. Se ejecuta en el servicio one-shot n8n-import antes de arrancar n8n.
set -eu
: "${N8N_API_SERVICE_TOKEN:?falta}" "${N8N_WEBHOOK_SECRET:?falta}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
umask 077
cat > "$TMP/credentials.json" <<JSON
[
  {"id": "scApiServiceCred01", "name": "SaludCita API (servicio n8n)", "type": "httpHeaderAuth",
   "data": {"name": "Authorization", "value": "Bearer svc_${N8N_API_SERVICE_TOKEN}"}},
  {"id": "scWebhookSecret01", "name": "SaludCita webhook (secreto compartido)", "type": "httpHeaderAuth",
   "data": {"name": "x-saludcita-webhook-secret", "value": "${N8N_WEBHOOK_SECRET}"}}
]
JSON

n8n import:credentials --input="$TMP/credentials.json"
n8n import:workflow --separate --input=/workflows
# Solo se publican los workflows marcados con meta.saludcita_publish = true. El de Google Calendar queda
# importado pero sin publicar hasta configurar y probar sus credenciales.
for f in /workflows/*.json; do
  id=$(node -e "process.stdout.write(require('$f').id)")
  pub=$(node -e "process.stdout.write(String(Boolean((require('$f').meta || {}).saludcita_publish)))")
  if [ "$pub" = "true" ]; then
    n8n publish:workflow --id="$id"
  else
    echo "Importado sin publicar: $id"
  fi
done
echo "n8n: credenciales y workflows importados y publicados."
