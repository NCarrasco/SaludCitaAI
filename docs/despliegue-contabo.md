# Guía de despliegue en un VPS (Contabo)

> **Estado (24-oct-2026): desplegado y en funcionamiento.** El sistema completo (API y panel, chat, n8n, PostgreSQL y
> Ollama) corre en un VPS Contabo Cloud VPS 30 (8 vCPU, 23 GB de RAM, **sin GPU**, Ubuntu) detrás de Caddy con HTTPS.
> Esta guía describe los pasos; la sección 8 resume lo que se usó realmente. Las direcciones y claves del servidor del
> equipo no se publican en el repositorio.

Servidor: VPS con **Ubuntu 24.04 LTS** y Docker. Mínimo recomendado: 4 vCPU y 8 GiB de RAM; con un modelo local de respaldo, 8 vCPU y 16 GiB o más.

## 1. Requisitos previos (los aporta el equipo)

| Elemento | Detalle |
|---|---|
| Acceso | Usuario con `sudo` y **clave SSH**. Sin contraseña para SSH |
| DNS | Tres registros A hacia la IP del VPS: `APP_DOMAIN` (panel y API), `CHAT_DOMAIN` (Gradio) y `N8N_DOMAIN` (editor de n8n) |
| Correo ACME | Correo para Let's Encrypt (`ACME_EMAIL`) |
| Destino de copias | Almacenamiento **fuera del VPS** (otro servidor o un almacenamiento de objetos) y una frase de cifrado custodiada por el equipo |
| Google Calendar | Opcional y pendiente ([google-calendar.md](google-calendar.md)). La URI de redirección será `https://N8N_DOMAIN/rest/oauth2-credential/callback` |

Ningún secreto debe enviarse por chat ni guardarse en Git.

## 2. Preparar el servidor

```bash
sudo apt update && sudo apt full-upgrade -y && sudo apt install -y ufw fail2ban unattended-upgrades git
```

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Cortafuegos: solo SSH, HTTP y HTTPS. HTTP se necesita para el reto ACME y la redirección.

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
```

SSH solo con clave: en `/etc/ssh/sshd_config.d/10-saludcita.conf` pon `PasswordAuthentication no` y `PermitRootLogin no`, y después:

```bash
sudo systemctl reload ssh
```

Docker Engine y Compose v2 se instalan desde el repositorio oficial de Docker para Ubuntu, siguiendo https://docs.docker.com/engine/install/ubuntu/:

```bash
sudo usermod -aG docker "$USER"
```

> Docker publica los puertos saltándose UFW. Por eso `compose.prod.yaml` **no publica ningún puerto** salvo los de Caddy (80/443): PostgreSQL, la API, n8n, Ollama y Gradio solo son accesibles por la red interna.

## 3. Instalar SaludCita AI

```bash
git clone <url-del-repositorio> saludcita && cd saludcita && ./scripts/bootstrap-env.sh
```

Edita `.env` (con permisos `600`) y añade o cambia:

```ini
COOKIE_SECURE=true
APP_DOMAIN=panel.ejemplo.org
CHAT_DOMAIN=citas.ejemplo.org
N8N_DOMAIN=n8n.ejemplo.org
ACME_EMAIL=equipo@ejemplo.org
N8N_EDITOR_USER=equipo
# Hash bcrypt de la contraseña del editor; los «$» se duplican en .env de Compose
N8N_EDITOR_PASSWORD_HASH=...
CORS_ALLOWED_ORIGINS=
```

El hash del editor de n8n se genera así (te pedirá la contraseña):

```bash
docker run --rm -it caddy:2.11.7-alpine caddy hash-password
```

Arranque:

```bash
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.prod.yaml --profile ai up -d --build
```

```bash
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.prod.yaml --profile ai exec ollama ollama pull qwen3:1.7b
```

Al terminar, crea la cuenta de propietario de n8n en `https://N8N_DOMAIN` (detrás de la autenticación básica) y guarda `N8N_ENCRYPTION_KEY` con el procedimiento de copias.

## 4. Verificación tras el despliegue

| Comprobación | Cómo |
|---|---|
| HTTPS y redirección | `curl -I http://APP_DOMAIN` devuelve 308 a https. El certificado es válido |
| Salud | `curl https://APP_DOMAIN/api/v1/health/ready` devuelve `ready` |
| Endpoints internos no expuestos | `curl -i -X POST https://APP_DOMAIN/api/v1/internal/scheduler/tick` devuelve 404 |
| Puertos | Desde fuera, `nmap` solo muestra 22, 80 y 443 |
| Cookies | La cookie `sc_admin` lleva `Secure` y `HttpOnly` |
| Panel y chat | `https://APP_DOMAIN/panel/` y `https://CHAT_DOMAIN` |
| n8n | Workflows Conversación y Planificador publicados. Google Calendar sin publicar mientras falten credenciales |
| Prueba de humo | Desde una máquina del equipo: `API_URL=https://APP_DOMAIN/api/v1 node scripts/smoke-test.mjs` (usa los secretos del `.env` del servidor; ejecútala en el propio VPS si tiene Node 24) |

## 5. Copias de seguridad fuera del VPS

Copia diaria cifrada con cron. La frase vive en un archivo de solo lectura para root, nunca en Git.

```bash
0 3 * * *  cd /home/<usuario>/saludcita && BACKUP_PASSPHRASE="$(cat /root/.saludcita-backup-pass)" ./scripts/backup.sh /var/backups/saludcita && rclone copy /var/backups/saludcita remoto:saludcita-backups
```

- **Retención propuesta:** 7 diarias, 4 semanales y 3 mensuales (a confirmar por el equipo).
- **Ensayo de restauración:** al menos mensual, en un entorno separado, con `scripts/restore.sh` y `scripts/verify-restore.sh`. Así se ensayó en local; ver evidencias/entrega-5/backup-restauracion.md (carpeta de evidencias).
- **Sin `N8N_ENCRYPTION_KEY` no se recuperan las credenciales de n8n:** viaja cifrada dentro de la copia (`instance.env`).

## 6. Operación

- **Actualizar:** `git pull` y el mismo `up -d --build`. Las migraciones son versionadas y se aplican al arrancar `migrate`.
- **Registros:** `docker compose … logs -f api n8n`. La rotación está limitada a 5 × 10 MB por servicio.
- **Reinicio automático:** `restart: unless-stopped` en todos los servicios persistentes. Tras un reinicio, el planificador recupera los trabajos pendientes (probado en local).
- **Un solo VPS es un punto único de fallo**, aceptado para la demo; no es alta disponibilidad.

## 7. Medición del modelo en el VPS

Con todos los servicios activos en el VPS:

```bash
cd apps/api && npm ci
```

```bash
OLLAMA_EVAL_URL=http://127.0.0.1:11434 EVAL_BATTERY=reserved-v2.json npx tsx eval/interpretation.ts qwen3:1.7b
```

```bash
npx tsx eval/e2e.ts --battery reserved-v2.json
```

```bash
docker stats --no-stream
```

En producción Ollama no publica su puerto. Para esta medición, ejecútala con un `ports: ["127.0.0.1:11434:11434"]` temporal en una superposición local, o desde el contenedor de la API.

**Criterios para declarar viable el modelo en el VPS** (propuesta para el equipo):

- p90 de latencia de extremo a extremo por debajo de 10 s;
- ningún proceso terminado por falta de memoria con todos los servicios activos;
- memoria total por debajo del 85 % de la RAM;
- resultados de `reserved-v2` comparables a los locales.

Si no se cumplen, el equipo decidirá entre reducir el alcance conversacional o habilitar un proveedor externo con presupuesto explícito. No se activará ningún servicio de pago automáticamente.

## 8. Lo que se usó en el despliegue real (24-oct-2026)

| Aspecto | Decisión |
|---|---|
| Servidor | Contabo Cloud VPS 30: 8 vCPU, 23 GB, sin GPU. Cortafuegos `ufw` con solo 22, 80 y 443 |
| Dominios | Sin dominio propio: subdominios de [sslip.io](https://sslip.io) que apuntan a la IP (`panel.<ip>.sslip.io`, `chat.<ip>.sslip.io`, `n8n.<ip>.sslip.io`). Caddy obtiene los certificados HTTPS automáticamente |
| Arranque | `docker compose --env-file .env -f infra/compose.yaml -f infra/compose.prod.yaml -f infra/compose.vps.yaml --profile ai up -d --build` |
| Modelo principal | **Groq** (gratis, compatible con OpenAI), modelo `openai/gpt-oss-120b`: ~1 s por llamada. `.env`: `LLM_PROVIDER=openai`, `LLM_API_BASE=https://api.groq.com/openai/v1`, `LLM_API_MODEL=openai/gpt-oss-120b`, `LLM_API_KEY=<clave de console.groq.com>` |
| Respaldo | `LLM_FALLBACK=ollama` con `OLLAMA_MODEL=qwen3:1.7b` en el mismo VPS: si Groq falla (límite diario, caída o más de 15 s), la API reenvía la petición al modelo local (~12–35 s en CPU). `LLM_TIMEOUT_MS=55000` |
| Por qué no solo el modelo local | En CPU, `qwen3:4b` tardaba ~2 min por mensaje y `qwen3:1.7b` entiende peor: se deja como respaldo |
| Editor de n8n | Autenticación básica de Caddy opcional (`N8N_BASIC_AUTH=on/off`); en la demostración quedó `off` y el acceso lo protege la cuenta de propietario de n8n |
| Límite gratuito de Groq | ~8 000 tokens por minuto y ~200 000 por día (unos 40–50 mensajes de paciente al día). Al agotarse responde el respaldo |

