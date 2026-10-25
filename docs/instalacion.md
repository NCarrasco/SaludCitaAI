# Guía de instalación y ejecución

Esta guía explica cómo descargar SaludCita AI y ponerlo en marcha en un ordenador propio. Solo hace falta **Docker**:
la base de datos, la API, el panel, el chat, n8n y el modelo de lenguaje se ejecutan en contenedores.

> Se comprobó el 24-oct-2026 desde una copia limpia del repositorio, siguiendo estos mismos pasos. La prueba de humo
> superó sus 16 comprobaciones: reserva, cancelación, reprogramación, conversación por n8n con el modelo local, panel y permisos.

## 1. Requisitos

| Requisito | Detalle |
|---|---|
| Docker Desktop (Windows / macOS) o Docker Engine + Compose v2 (Linux) | https://docs.docker.com/get-docker/ |
| Memoria asignada a Docker | **6 GB o más** (el modelo local usa ~2 GB). En Docker Desktop: *Settings → Resources* |
| Disco libre | ~6 GB (imágenes ~3 GB y modelo `qwen3:1.7b` 1,4 GB) |
| Git | Para clonar el repositorio |
| Bash y OpenSSL | Para generar el archivo `.env`. En macOS y Linux vienen instalados; en **Windows** usa **Git Bash** (incluido con Git para Windows) o WSL2 |
| Internet | Solo la primera vez, para descargar imágenes y el modelo |
| Puertos libres en `127.0.0.1` | 7860 (chat), 8080 (API y panel), 5678 (n8n), 55433 (PostgreSQL), 11434 (Ollama). Se pueden cambiar en `.env` |

Opcional: **Node.js 24** (para ejecutar la prueba de humo y las pruebas automáticas) y una **clave gratuita de Groq**
(para que el asistente responda en ~1 s en lugar de 10–35 s; ver la sección 4).

> **Docker Desktop en macOS:** clona el proyecto dentro de tu carpeta de usuario (`/Users/...`). En carpetas no compartidas
> con Docker (por ejemplo `/private/tmp`), PostgreSQL no ve su script de inicio y `migrate` falla con
> «password authentication failed».

## 2. Instalación (5 pasos)

**Paso 1. Descargar el proyecto**

```bash
git clone <url-del-repositorio> SaludCitaAI
```

```bash
cd SaludCitaAI
```

**Paso 2. Crear el archivo de configuración `.env`**

```bash
./scripts/bootstrap-env.sh
```

Copia `.env.example` en `.env` y genera contraseñas y secretos aleatorios. El archivo `.env` no se sube a Git.

**Paso 3. Construir y arrancar todos los servicios**

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ai up -d --build
```

La primera vez tarda varios minutos (descarga imágenes y compila la API, el panel y el chat). Arranca en orden:

1. **PostgreSQL**.
2. **migrate**: crea las tablas, carga los datos ficticios y crea los usuarios de demostración.
3. La **API**, que también sirve el panel.
4. **n8n-import**: importa y publica los flujos de n8n.
5. **n8n**.
6. **Ollama**: el modelo local, perfil `ai`.
7. El **chat** (Gradio).

**Paso 4. Descargar el modelo de lenguaje local** (una sola vez, 1,4 GB)

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ai exec ollama ollama pull qwen3:1.7b
```

**Paso 5. Comprobar que todo funciona**

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ai ps
```

`postgres`, `api` y `n8n` deben aparecer como `healthy`; `ollama` y `gradio`, como `Up`. Para comprobar la API:

```bash
curl -s http://127.0.0.1:8080/api/v1/health/ready
```

Si tienes Node.js 24, la prueba de humo comprueba el sistema completo en unos 15 s:

```bash
node scripts/smoke-test.mjs
```

## 3. Cómo usarlo

| Para | Dirección | Acceso |
|---|---|---|
| **Pacientes**: página del hospital con el asistente flotante «Salu» | http://127.0.0.1:7860 | Sin registro (sesión de invitado automática) |
| Chat del paciente a pantalla completa | http://127.0.0.1:7860/chat/ | Igual que arriba |
| **Personal**: panel administrativo | http://127.0.0.1:8080/panel/ | `admin@saludcita.test` / `12345678` (el formulario ya viene rellenado) |
| Documentación interactiva de la API (Swagger) | http://127.0.0.1:8080/api/v1/docs | Pública (solo lectura) |
| Editor de flujos de n8n | http://127.0.0.1:5678 | La primera vez pide crear una cuenta de propietario local |

**Cuentas de demostración** (todos los datos son ficticios):

| Cuenta | Rol | Contraseña |
|---|---|---|
| `admin@saludcita.test` | Administración: todo, incluida Configuración y Sistema | `12345678` |
| `operador@saludcita.test` | Operación: citas, asistencia y solicitudes de ayuda | `12345678` |
| `panel@saludcita.test` | Solo lectura: estadísticas agregadas, sin datos de pacientes | `12345678` |
| `paciente01` … `paciente20` | Pacientes ficticios con citas (menú ⋮ del chat → «Cuenta de demostración») | Valor de `SEED_PATIENT_PASSWORD` en tu `.env` |

### Recorrido sugerido (5 minutos)

1. Abre http://127.0.0.1:7860: Salu se presenta. Pulsa **Reservar cita**, elige una especialidad y un horario.
2. En la tarjeta **Confirma tu cita** escribe un nombre, una fecha de nacimiento y un teléfono o correo ficticios, y pulsa **Confirmar**.
   La cita aparece en **Mis citas**, con su comprobante en PDF, y llega un aviso a **Avisos**.
3. Escribe con tus palabras, por ejemplo: «¿hay cardiólogo el martes por la mañana?» o «what time is my appointment?».
4. Pulsa **Hablar con el personal** en el chat.
5. Abre el panel (http://127.0.0.1:8080/panel/). En **Inicio** aparecen la nueva cita y la solicitud de ayuda, en vivo.
   En **Solicitudes de ayuda** pulsa **Atender**, escribe una nota y resuélvela: el paciente la recibe en **Avisos**.
6. Explora **Citas** (filtros y detalle con historial), **Estadísticas** y **Configuración** (médicos, horarios y vista previa del asistente).

## 4. Opcional: respuestas rápidas con Groq (gratis)

En un ordenador sin tarjeta gráfica, el modelo local tarda entre 10 y 35 segundos por respuesta. Groq ofrece una API
gratuita compatible con OpenAI que responde en ~1 segundo:

1. Crea una cuenta en https://console.groq.com y genera una **API key** (menú *API Keys*).
2. Edita `.env` y cambia o añade estas líneas. Escribe la clave directamente en el archivo, nunca la pegues en otro sitio.

   ```ini
   LLM_PROVIDER=openai
   LLM_API_BASE=https://api.groq.com/openai/v1
   LLM_API_MODEL=openai/gpt-oss-120b
   LLM_API_KEY=gsk_...tu_clave...
   LLM_FALLBACK=ollama
   ```

3. Reinicia la API:

   ```bash
   docker compose --env-file .env -f infra/compose.yaml --profile ai up -d api
   ```

Con `LLM_FALLBACK=ollama`, si Groq falla o se agota su límite gratuito diario (~40–50 mensajes), responde
automáticamente el modelo local. La clave solo la usa la API: no llega a n8n ni al navegador.

## 5. Detener, reiniciar y borrar

Detener sin perder datos:

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ai down
```

Volver a arrancar (sin recompilar):

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ai up -d
```

Borrar todo, incluidos datos y modelo descargado, para empezar de cero:

```bash
docker compose --env-file .env -f infra/compose.yaml --profile ai down -v
```

Ver los registros de un servicio (por ejemplo, la API):

```bash
docker compose --env-file .env -f infra/compose.yaml logs -f api
```

## 6. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `port is already allocated` | Otro programa usa ese puerto. Cambia `API_HOST_PORT`, `GRADIO_HOST_PORT`, `N8N_HOST_PORT`, `POSTGRES_HOST_PORT` u `OLLAMA_HOST_PORT` en `.env` y vuelve a ejecutar el paso 3 |
| `migrate` falla con «password authentication failed» | El proyecto está en una carpeta que Docker no comparte (macOS), o quedó un volumen de un intento anterior con otras contraseñas. Mueve el proyecto a tu carpeta de usuario y ejecuta `down -v` antes de reintentar |
| `./scripts/bootstrap-env.sh: Permission denied` | Ejecuta `bash scripts/bootstrap-env.sh` |
| En Windows, `bootstrap-env.sh` no se ejecuta | Ábrelo desde **Git Bash** o WSL2, no desde CMD ni PowerShell |
| El chat responde «Estoy tardando más de lo normal…» o solo muestra el menú | El modelo local no está descargado (paso 4), Docker tiene poca memoria o el equipo es lento. El menú guiado sigue funcionando; para respuestas rápidas usa Groq (sección 4) |
| El panel dice «Demasiados intentos» | Límite de 10 inicios de sesión cada 5 minutos por correo. Espera o reinicia la API |
| Cambié `SEED_ADMIN_PASSWORD` y no funciona | Se aplica al arrancar `migrate`: ejecuta otra vez el paso 3 |

## 7. Para desarrolladores

### Pruebas automáticas de la API (233 pruebas)

Necesitan PostgreSQL en marcha (paso 3) y Node.js 24. Usan una base aparte (`saludcita_test`) que se recrea en cada ejecución:

```bash
cd apps/api && npm ci && npm test
```

Cubren reservas concurrentes del mismo horario, reintentos idempotentes, aislamiento entre pacientes, permisos por
rol, migraciones reversibles, el contrato OpenAPI, la conversación y la pasarela de modelos con su respaldo. La salida del
modelo se simula; su calidad real se mide aparte en `apps/api/eval` ([evaluacion-ia-local.md](evaluacion-ia-local.md)).

### Pruebas de interfaz (Playwright)

Usan una instancia del chat aparte (puerto 7861) para no compartir límites con el uso normal:

```bash
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.e2e.yaml --profile e2e up -d gradio-e2e
```

```bash
cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test
```

### Otros comandos

| Comando | Qué hace |
|---|---|
| `cd apps/api && npm run typecheck` | Comprobación de tipos de TypeScript |
| `cd apps/api && npm run openapi:export` | Regenera `contracts/openapi.yaml` desde el código |
| `node scripts/demo-trace.mjs` | Demostración trazable: Gradio/API → n8n → modelo → API, comprobando cada paso en su fuente |
| `node scripts/e2e-offers-n8n.mjs` | Ofertas de adelanto con el planificador real de n8n (hasta 90 s) |
| `node scripts/measure-latency.mjs --rounds 2` | Latencia por etapa |
| `BACKUP_PASSPHRASE='…' ./scripts/backup.sh --pause-writers` | Copia de seguridad cifrada en `backups/`; restauración con `scripts/restore.sh` y `scripts/verify-restore.sh` |

### Desarrollo de la API sin contenedor

```bash
cd apps/api && npm ci
```

```bash
set -a && source ../../.env && set +a && DATABASE_URL="postgres://$APP_DB_USER:$APP_DB_PASSWORD@127.0.0.1:$POSTGRES_HOST_PORT/$APP_DB_NAME" PORT=18080 npm run dev
```

### Dos instancias en el mismo equipo

Usa otro `.env` con un `COMPOSE_PROJECT_NAME` distinto (crea contenedores y volúmenes propios) y otros puertos
(`*_HOST_PORT`). **No reutilices el nombre de proyecto de una instancia existente**: compartirías sus datos.

## 8. Despliegue en un servidor

Para publicarlo en internet con HTTPS (Caddy, dominios y respaldo del modelo), sigue
[despliegue-contabo.md](despliegue-contabo.md). Así se desplegó la demostración del equipo en un VPS Contabo.
