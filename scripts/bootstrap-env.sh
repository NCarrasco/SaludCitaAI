#!/usr/bin/env bash
# Crea .env a partir de .env.example generando secretos aleatorios locales.
# Si .env ya existe, solo añade las claves nuevas de .env.example (no modifica las existentes).
set -euo pipefail
cd "$(dirname "$0")/.."
render() {
  local line="$1"
  if [[ "$line" == *"=<generar>"* ]]; then
    echo "${line%%=*}=$(openssl rand -hex 18)"
  else
    echo "$line"
  fi
}
if [[ ! -f .env ]]; then
  while IFS= read -r line; do render "$line"; done < .env.example > .env
  chmod 600 .env
  echo ".env creado con secretos aleatorios locales."
  exit 0
fi
added=0
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)= ]] || continue
  key="${BASH_REMATCH[1]}"
  if ! grep -q "^${key}=" .env; then
    render "$line" >> .env
    added=$((added + 1))
  fi
done < .env.example
echo ".env ya existía; claves añadidas: ${added}."
