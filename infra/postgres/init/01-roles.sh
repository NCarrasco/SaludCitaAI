#!/bin/sh
# Se ejecuta solo al crear el volumen por primera vez.
# Crea bases y roles separados para la aplicación y para n8n.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_db="$APP_DB_NAME" -v app_user="$APP_DB_USER" -v app_pw="$APP_DB_PASSWORD" \
  -v n8n_db="$N8N_DB_NAME" -v n8n_user="$N8N_DB_USER" -v n8n_pw="$N8N_DB_PASSWORD" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw';
CREATE DATABASE :"app_db" OWNER :"app_user";
CREATE ROLE :"n8n_user" LOGIN PASSWORD :'n8n_pw';
CREATE DATABASE :"n8n_db" OWNER :"n8n_user";
REVOKE ALL ON DATABASE :"app_db" FROM PUBLIC;
REVOKE ALL ON DATABASE :"n8n_db" FROM PUBLIC;
-- Base auxiliar para pruebas automatizadas (solo local)
CREATE DATABASE saludcita_test OWNER :"app_user";
SQL
# btree_gist es una extensión de confianza (PostgreSQL ≥ 13): la crea la primera migración como propietario
# de la base, de modo que una restauración con pg_restore la recrea sin conflictos.
