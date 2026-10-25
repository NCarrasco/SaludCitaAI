# Integración con la API de SaludCita AI

Guía para consumir la API local. El contrato completo está en [contracts/openapi.yaml](../contracts/openapi.yaml) (OpenAPI 3.1, generado desde el código y validado con Redocly). Los ejemplos de abajo son respuestas reales del entorno local con datos ficticios.

- URL local: `http://127.0.0.1:8080/api/v1`
- Formato: JSON. UUID como identificadores. Fechas RFC 3339 con desplazamiento (`-04:00`, zona `America/Santo_Domingo`).
- Errores: `{"error":{"code","message","details"},"request_id"}`. Códigos HTTP: 400 validación, 401 sin autenticación, 403 sin permiso o token incorrecto, 404 recurso no visible, 409 conflicto/versión/idempotencia, 410 intención caducada, 429 límite de intentos, 503 dependencia no disponible.
- Cada respuesta incluye la cabecera `x-request-id` para rastrear errores.

> La API del panel administrativo (estadísticas, roles, mantenimiento y cookies de sesión) está documentada en [panel-administrativo.md](panel-administrativo.md). Esta guía cubre la API de pacientes.

## Autenticación de pacientes

```http
POST /api/v1/patient-auth/login
{"username": "paciente01", "password": "<SEED_PATIENT_PASSWORD>"}
```

Devuelve `token` (prefijo `pat_`), `expires_at` y el perfil del paciente. Se envía como `Authorization: Bearer <token>`. Lo guarda el backend de Gradio en el servidor y no se pasa al modelo. El login admite 10 intentos por IP y usuario cada 5 minutos.

`GET /patient-auth/me` devuelve el paciente de la sesión. `POST /patient-auth/logout` revoca la sesión.

La identidad del paciente **siempre** sale de la sesión. Ninguna ruta acepta un `patient_id` del cliente.

## Flujo de reserva

1. **Buscar** horarios reales: `GET /availability?specialty_id=…&from=…&to=…&limit=…`. El intervalo es `[from, to)`, de 31 días como máximo, con paginación por `next_cursor`. Solo devuelve slots reservables en ese instante.
2. **Preparar** la operación: `POST /action-intents`. Valida contra la agenda y devuelve un token de un solo uso. No modifica nada ni retiene el horario.
3. **Confirmar** de forma explícita (por ejemplo, con un botón): `POST /action-intents/{id}/submit` con la cabecera `Idempotency-Key`. La API registra la **orden** (202) y n8n la ejecuta como comando durable `appointment.confirm`; el resultado se consulta en `GET /action-intents/{id}/confirmation`. No existe ruta del paciente que ejecute la operación directamente.

### Preparar una reserva

```http
POST /api/v1/action-intents
Authorization: Bearer pat_…
{"kind": "booking", "slot_id": "0a25ae12-4ee3-46c7-a015-0ac58fd1b04b", "advance_opt_in": true}
```

```json
{
  "intent_id": "0b906ca2-e84a-48c4-af6f-5fb88269ae9c",
  "kind": "booking",
  "token": "int_…(omitido)",
  "expires_at": "2026-10-23T18:15:24-04:00",
  "holds_slot": false,
  "summary": {
    "slot": {
      "slot_id": "0a25ae12-4ee3-46c7-a015-0ac58fd1b04b",
      "doctor_service_id": "40000000-0000-4000-8000-000000000001",
      "starts_at": "2026-10-26T08:00:00-04:00",
      "ends_at": "2026-10-26T08:20:00-04:00",
      "label": "lunes, 26 de octubre de 2026, 8:00 a. m.",
      "timezone": "America/Santo_Domingo",
      "doctor": { "id": "30000000-0000-4000-8000-000000000001", "display_name": "Dra. Ana Lucía Méndez (ficticia)" },
      "specialty": { "id": "20000000-0000-4000-8000-000000000001", "name": "Medicina Interna" },
      "center": { "id": "10000000-0000-4000-8000-000000000001", "name": "Hospital Simulado SaludCita",
                  "address": "Av. Ficticia 100, Distrito Nacional (dirección simulada)" },
      "consultation_kind": "initial",
      "patient_instructions": "Llegue 15 minutos antes con su documento de identidad."
    }
  }
}
```

Otras intenciones:

- Cancelar: `{"kind":"cancellation","appointment_id":"…","expected_version":1,"reason_code":"patient_request"}`.
- Reprogramar: `{"kind":"reschedule","appointment_id":"…","expected_version":1,"new_slot_id":"…"}`.

`expected_version` evita aplicar una operación preparada sobre una versión anterior de la cita. Crear una intención nueva invalida las pendientes del mismo paciente.

### Confirmar (orden ejecutada por n8n)

```http
POST /api/v1/action-intents/0b906ca2-…/submit
Authorization: Bearer pat_…
Idempotency-Key: 6d0c2c0e-6a2f-4f0a-9c55-1b0c3c7e2b11
{"token": "int_…"}
```

Respuesta `202`: `{"status": "queued", "intent_id": "…", "command_id": "…", "correlation_id": "…"}`. Reenviar (misma u otra
clave) devuelve la **misma** orden. Después se consulta `GET /api/v1/action-intents/0b906ca2-…/confirmation` hasta un estado
terminal:

| `status` | Significado |
|---|---|
| `queued` / `running` | En cola o ejecutándose en n8n: todavía sin resultado |
| `confirmed` | La API la ejecutó; `result` tiene el resultado (ejemplo debajo) |
| `failed` | Rechazo de negocio (`error.status` 409/410…) o la orden agotó sus intentos: **sin cambios** |
| `expired` | n8n no la ejecutó en 120 s: se descartó **sin cambios** |

Una orden `failed` o `expired` no se puede revivir con el mismo token: para reintentar, se prepara una intención nueva
(`POST /action-intents`, que revalida la disponibilidad) y se envía su orden. Resultado de una orden `confirmed`:

```json
{
  "intent_id": "0b906ca2-e84a-48c4-af6f-5fb88269ae9c",
  "kind": "booking",
  "outcome": "booked",
  "appointment": {
    "id": "4a7727cc-1a58-4ad1-9d84-d4c269cd5829",
    "booking_reference": "SC-LYY9SF",
    "status": "booked",
    "version": 1,
    "advance_opt_in": true,
    "booked_at": "2026-10-23T18:05:24-04:00",
    "cancelled_at": null,
    "cancellation_reason_code": null,
    "slot": { "…": "igual que en summary.slot" }
  }
}
```

- Mismo `Idempotency-Key` y mismo cuerpo: la misma respuesta, con la cabecera `idempotent-replayed: true`.
- Mismo `Idempotency-Key` con otro cuerpo: `409 idempotency_key_reused`.
- Intención ya consumida: devuelve el resultado original.
- `outcome` puede ser `booked`, `cancelled`, `already_cancelled` o `rescheduled`.

### Conflictos habituales

```json
{
  "error": { "code": "slot_unavailable", "message": "El horario ya está reservado", "details": { "reason": "occupied" } },
  "request_id": "1752aae3-ec25-4a13-bf1e-ec9bb542b6b1"
}
```

| `error.code` | HTTP | Significado |
|---|---|---|
| `slot_unavailable` | 409 | `details.reason`: `occupied`, `held_by_offer`, `blocked`, `too_soon`, `beyond_horizon`, `service_inactive` |
| `patient_overlap` | 409 | El paciente ya tiene otra cita activa en ese intervalo |
| `appointment_version_mismatch` | 409 | La cita cambió después de preparar la operación |
| `appointment_not_active` / `appointment_started` | 409 | La cita no está reservada o ya comenzó |
| `intent_invalidated` | 409 | Una intención más reciente del paciente reemplazó a esta |
| `intent_expired` | 410 | Pasó el plazo de confirmación (600 s por defecto) |
| `forbidden` | 403 | El token de confirmación no corresponde |
| `not_found` | 404 | No existe o pertenece a otro paciente |

## Consultas del paciente

- `GET /appointments?scope=upcoming|past|all&status=…&limit=…&cursor=…`: solo citas propias.
- `GET /appointments/{id}`: 404 si no existe o es ajena.
- `PATCH /patients/me`: `{"full_name": "…", "birth_date": "AAAA-MM-DD"}`. No acepta otros campos.
- Catálogos: `GET /centers`, `GET /specialties`, `GET /doctors?specialty_id=…&center_id=…`.

## Conversación (entrega 2)

- `POST /conversation/messages` con `{client_message_id, text}`: responde 202 con `update_id`. El texto lo interpreta el modelo local a través de n8n.
- `GET /conversation/updates/{id}`: devuelve `{status: pending|done, reply}`. 404 si el mensaje es de otro paciente.
- `POST /conversation/messages` con `{client_message_id, action}`: botones (`menu`, `choose_specialty`, `choose_date`, `select_option`, `more_options`, `choose_appointment`, `intent_result`, `discard_proposal`). Responde 200 inmediatamente, sin modelo.
- `GET /conversation`: historial reciente (memoria persistente).
- `GET /notifications` y `POST /notifications/{id}/read`: bandeja de avisos propia.
- `reply.mode` puede ser `ai`, `deterministic`, `fallback_menu` o `system`. `reply.proposal` describe una operación pendiente **sin tokens**: para ejecutarla, el cliente llama a `POST /action-intents` y envía la orden con `/submit` (la ejecuta n8n).
- Rutas internas para n8n (scope `bot`): `POST /internal/updates/claim`, `/internal/updates/{id}/route` (decide la rama), `/internal/updates/{id}/branch/{route}` (ejecuta la rama decidida; otra rama → 409), `/draft` y `/fail`. `/ack` (decidir y ejecutar en un paso) se conserva por compatibilidad.
