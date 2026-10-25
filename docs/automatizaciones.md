# Automatizaciones (entrega 4)

> **Estado de Google Calendar: PENDIENTE.** Hay un workflow importado (sin publicar) y pruebas de la cola con un cliente simulado. **Eso no equivale a una integración terminada**: no se ha creado, reprogramado ni cancelado ningún evento real en Google Calendar. La integración solo se dará por terminada cuando se pruebe con credenciales OAuth de una cuenta de prueba y quede evidencia.

Qué hace cada automatización, quién la ejecuta y qué está probado.

## Resumen

| Automatización | Dónde | Estado |
|---|---|---|
| Ofertas secuenciales de adelanto y cascada | API (en la transacción que libera el horario) | **Funcional y probada**: 11 pruebas de integración y prueba extremo a extremo con n8n |
| Vencimiento de ofertas | Workflow n8n «Planificador» (cada minuto) → `POST /internal/scheduler/tick` | **Funcional y probada con n8n real** |
| Recordatorios a 24 h y 1 h en la bandeja | Planificador | **Funcional y probado**. Solo bandeja web: sin SMS, correo ni push |
| Generación continua de agenda (30 días) | Planificador | Funcional (idempotente) |
| Recuperación tras reinicio (leases vencidos) | Planificador y reclamación de trabajos | **Probada con `compose down/up`** (evidencia (carpeta de evidencias)) |
| Sincronización con Google Calendar | Workflow n8n «Google Calendar» + cola durable | **Pendiente de credenciales. Sin probar contra Google.** La cola, los reintentos y la convergencia de versiones sí están probados en la API con un cliente simulado |

## Ofertas de adelanto

Reglas implementadas ([apps/api/src/modules/offers/service.ts](../apps/api/src/modules/offers/service.ts)):

1. **Ronda.** Cancelar o reprogramar una cita, o aceptar un adelanto, abre una ronda para el horario liberado. Todo ocurre en la misma transacción.
2. **Candidatos.** Son citas `booked` posteriores del **mismo servicio** (médico, centro, especialidad y duración) cuyo paciente aceptó recibir ofertas (`advance_opt_in`, la casilla al confirmar la reserva) y que no tienen otra cita solapada.
   - Orden: inicio actual de la cita, `booked_at` e id.
   - Cada cita se intenta como mucho una vez por ronda.
3. **Una oferta pendiente por ronda y por cita.** Lo garantizan índices únicos parciales en PostgreSQL. Mientras la ronda está abierta, el horario **no** aparece en la disponibilidad pública.
4. **Ventana.**
   - Normal: 1 h (`OFFER_WINDOW_SECONDS=3600`).
   - Solo se oferta si queda la ventana completa antes del inicio del horario. Si no, la ronda se cierra (`too_close_to_start`) y el horario vuelve a la reserva directa.
   - **Modo demostración:** con `OFFERS_DEMO_MODE=true` la ventana pasa a `OFFER_DEMO_WINDOW_SECONDS` (120 s por defecto). Queda registrado en `offer_rounds.demo_mode` y se indica en el aviso al paciente. No altera la regla normal.
5. **Aceptar** (`POST /offers/{id}/answer` con `{"action": "accept"}` e `Idempotency-Key`; registra la orden `offer.answer`, n8n la ejecuta y el resultado se consulta en `GET /offers/{id}/answer`. El plazo se evalúa en el momento en que el paciente respondió):
   - mueve la **misma cita** (misma referencia, versión + 1) al horario ofrecido;
   - registra el evento `advanced`, avisa al paciente y reprograma recordatorios y calendario;
   - **abre una ronda en cascada** para el horario anterior (`parent_round_id`).
6. **Rechazar**, **vencer** o **invalidar** una oferta pasa al siguiente candidato. Se invalida si la cita candidata cambia o se cancela, o si un cambio de agenda bloquea el horario. Sin candidatos, la ronda queda `exhausted` y el horario vuelve a la reserva pública.
7. **Carrera entre aceptación y vencimiento.** Decide la transacción que valida `expires_at` bajo bloqueo, con la hora del servidor. Una oferta vencida responde **410** aunque el planificador la haya procesado antes. Lo cubre una prueba que lanza aceptación y planificador en paralelo.
8. **`delivery_failed`.** No aparece en el canal web: publicar el aviso es una escritura en la misma transacción. Se conserva en el modelo para canales futuros.

El paciente ve y responde las ofertas en la pestaña **Avisos** del chat Gradio. El panel muestra las estadísticas en «Estadísticas › Adelantos».

## Planificador (n8n)

Workflow `workflows/n8n/scheduler.json` («SaludCita · Planificador (cada minuto)»), publicado automáticamente. Llama a `POST /internal/scheduler/tick` con la credencial de servicio (scope `scheduler`). Cada paso es idempotente:

1. Vence las ofertas cuyo plazo pasó y emite la siguiente oferta de cada ronda.
2. Devuelve a `pending` los trabajos con lease vencido (proceso caído).
3. Publica los recordatorios que ya tocan. Solo si la cita sigue `booked` con la **misma versión** y no ha empezado; en otro caso el trabajo se cierra como `cancelled`. Una cita reprogramada anula los recordatorios anteriores al crear los nuevos.
4. Cierra como «calendario no configurado» los trabajos de calendario de médicos sin vínculo habilitado, y deja `calendar_sync.status = disabled`. **No se simula ninguna sincronización.**
5. Mantiene generados los próximos 30 días de agenda.

## Cola durable (`outbox_jobs`)

- **Reclamación:** `POST /internal/jobs/claim` usa `FOR UPDATE SKIP LOCKED` y un lease de 120 s. Hay un único trabajo en curso por cita. Un trabajo de calendario con una versión anterior a la deseada se cierra como `superseded`.
- **Confirmación:** `POST /internal/jobs/{id}/ack` con el `lease_token` vigente. Un lease antiguo recibe 409. En calendario, `synced_version` nunca retrocede.
- **Fallo:** `POST /internal/jobs/{id}/fail` reintenta con backoff exponencial y jitter (30 s, 60 s, 120 s… hasta 30 min). A los 5 intentos el trabajo pasa a `dead` y `calendar_sync.status` a `failed`.
- **Reintento manual:** desde el panel («Sistema › Trabajos y reintentos») con rol `admin`.

## Google Calendar: activación pendiente

El workflow `workflows/n8n/calendar-google.json` se importa pero **no se publica**: falta una credencial OAuth real y nunca se ha ejecutado contra Google. Implementa un espejo unidireccional API → Google:

- `PUT` del evento con ID determinista (`sc` + UUID de la cita en hexadecimal);
- si el evento no existe (404), `POST` con ese ID;
- `DELETE` si la cita está cancelada (404/410 cuentan como borrado);
- en todos los casos, `ack` o `fail` a la API.

Los eventos no incluyen el nombre del paciente, solo la referencia y la especialidad.

Pasos para activarlo con una **cuenta de Google de prueba**:

1. En Google Cloud, crea un proyecto, habilita **Google Calendar API** y crea credenciales OAuth de tipo «Aplicación web». La URI de redirección es la que muestra n8n al crear la credencial (local: `http://localhost:5678/rest/oauth2-credential/callback`).
2. En n8n (http://127.0.0.1:5678), crea una credencial **Google Calendar OAuth2 API** llamada exactamente `Google Calendar (cuenta de prueba) — CONFIGURAR` y autoriza la cuenta de prueba. También puedes abrir el workflow y elegir tu credencial en los tres nodos de Google.
3. Crea en esa cuenta un calendario de prueba por médico y vincúlalo, por ahora en SQL. La edición desde el panel está pendiente.

   ```sql
   INSERT INTO calendar_bindings (doctor_id, provider, external_calendar_id, enabled)
   VALUES ('<doctor_id>', 'google', '<id-del-calendario>@group.calendar.google.com', true);
   ```

4. Publica el workflow «SaludCita · Google Calendar» en n8n y crea o cambia una cita de ese médico. Verifica el evento en Google y en el panel: `calendar_sync` en estado `synced`.
5. Hasta completar estos pasos, el panel muestra **«Pendiente de credenciales»**, y este documento y el README mantienen la integración como no probada.

Revisa también las cuotas vigentes de la Calendar API para la cuenta: https://developers.google.com/workspace/calendar/api/guides/quota

## Pruebas

| Prueba | Qué demuestra |
|---|---|
| `apps/api/test/integration/offers-jobs.test.ts` | Cascada con 2 aceptaciones; rechazo y ronda agotada; vencimiento por el planificador; carrera entre aceptación y vencimiento (vencida y vigente); cita candidata modificada; horario cercano al inicio; ausencia que invalida la oferta; recordatorios solo de versiones vigentes; calendario sin credenciales; convergencia de create/update/delete; trabajo reemplazado; lease recuperado; backoff y estado `dead` |
| `scripts/e2e-offers-n8n.mjs` | El workflow real de n8n vence una oferta y emite la siguiente; aceptación con cascada |
| evidencias/entrega-4/reinicio-recuperacion.txt (carpeta de evidencias) | Datos y trabajos sobreviven a `compose down/up` y se procesan al volver |
