# Incremento A: arquitectura actualizada y sesión invitada segura (23-oct-2026)

## Qué funciona realmente (verificado en local)

- Un visitante abre el chat **sin registrarse** y recibe una sesión de dispositivo (cookie HttpOnly `sc_device`, 30 días). Al recargar conserva conversación y citas.
- Puede **reservar** con el menú o con texto libre. Antes de confirmar se le piden nombre y fecha de nacimiento ficticios; sin ellos la API no crea la cita.
- Pestaña **«Tu acceso»**: generar el código de recuperación (se muestra una vez), revocarlo, recuperar el acceso en otro dispositivo, cerrar sesión aquí o en los demás dispositivos y entrar con una cuenta de demostración.
- La **recuperación** en otro navegador da acceso a las mismas citas, invalida el código usado y emite uno nuevo, que se muestra una sola vez.
- **Aislamiento**: otro visitante no ve nada de la primera sesión.
- La conversación con n8n y Ollama funciona con la nueva identidad (`p:<patient_id>`).

## Archivos y decisiones

- API:
  - `database/migrations/0008_guest_sessions` (up/down);
  - `apps/api/src/modules/guest/` (servicio y rutas `/gateway/*`, `/patient-auth/recovery-code`, `/patient-auth/sessions/revoke-others`);
  - `plugins/auth.ts` (principal del paciente por `patient_id`);
  - `appointments/service.ts` (409 `profile_required`);
  - `contracts/openapi.yaml` regenerado.
- Gradio:
  - `apps/demo-gradio/server.py` (nuevo, FastAPI con Gradio montado);
  - `app.py`: sin formulario de login; carga desde la cookie; pestaña «Tu acceso»; perfil en la confirmación;
  - `api_client.py`;
  - Dockerfile: `uvicorn server:app`, sin cabeceras de proxy por defecto.
- Configuración: `GRADIO_GATEWAY_TOKEN`, `GUEST_SESSION_TTL_DAYS`, `RECOVERY_CODE_TTL_DAYS` y `GRADIO_TRUST_PROXY_HEADERS` en `.env.example` y Compose. `bootstrap-env.sh` las añade a un `.env` existente.
- Decisiones: [decisiones-implementacion.md §9B](../decisiones-implementacion.md).

## Pruebas y resultados

| Prueba | Resultado |
|---|---|
| API (Vitest), incluida `guest.test.ts` (8 pruebas: creación, aislamiento, código de un solo uso, rotación, revocación, caducidad, límites, perfil requerido) | 109/109 |
| Interfaz (Playwright): `gradio-invitado.spec.ts` (reserva sin registro, recarga, aislamiento, recuperación en un segundo contexto, código usado rechazado, cookie HttpOnly e inaccesible a JS, rutas /acceso/* protegidas) más las previas adaptadas | 12/12 |
| Prueba de humo | Superada |
| Demo trazable con n8n y Ollama reales | Todas las comprobaciones superadas |

Evidencia: evidencias/incremento-a/pruebas.txt (carpeta de evidencias).

## Limitaciones y dependencias pendientes

- Los límites por IP comparten contador detrás de una NAT. En pruebas locales todas las peticiones salen de la misma IP: se crean unas 4 sesiones invitadas por ejecución, frente a un máximo de 30 por hora.
- El código de recuperación pendiente de mostrar vive en memoria del proceso de Gradio durante 5 minutos. Si Gradio se reinicia en ese intervalo, el paciente debe generar otro desde su sesión, que sigue válida.
- No hay limpieza programada de pacientes invitados abandonados. Se propone para el incremento C (tarea en n8n).
- Aspecto de mensajería (WhatsApp), robot y sonidos: **incremento B, el siguiente**.
- Siguen pendientes: Google Calendar real, medición en Contabo y los incrementos B–I.
