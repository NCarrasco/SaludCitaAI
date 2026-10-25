# Incrementos C (orquestación completa en n8n) y E (comprobante PDF) — 24-oct-2026

## Qué funciona (verificado en local con n8n real)

### C · Comandos durables orquestados por n8n
- **Encargo de comandos:** al confirmar una cita, cambiarla, aceptar un adelanto o reintentar un comprobante, la API encarga los comandos en la **misma transacción** que la operación (`outbox_jobs`), con su `correlation_id`. Es el mismo que el de `appointment_events` y la analítica.
- **Idempotencia:** `dedupe_key` impide duplicar comandos al repetir una confirmación.
- **Workflow nuevo, «SaludCita · Comandos durables»:**

| Paso | Qué hace |
|---|---|
| 1 | Aviso inmediato de la API (webhook) |
| 1b | Recuperación cada 30 s |
| 2 | Reclamar comandos con lease |
| 3 | Un comando a la vez |
| 4 | Switch por tipo, con ramas explícitas |
| 5a | Generar el comprobante PDF |
| 5b | Publicar el recordatorio |
| 5c | Limpiar sesiones invitadas |
| 6 | Registrar el fallo: reintento con backoff y `dead` al agotar intentos |

- Cada rama llama a su propio endpoint: un tipo no se ejecuta por otra rama. La API ejecuta el trabajo y marca el comando como hecho en una sola transacción.
- **Robustez:**
  - si n8n cae a mitad, el lease vence y el comando se reclama de nuevo;
  - repetir la ejecución con el mismo lease devuelve el mismo resultado;
  - un lease viejo recibe 409.
- **Recordatorios:** dejan de publicarse dentro del `tick` de la API. Son comandos que ejecuta n8n, y se publican solo si la cita sigue vigente con la versión esperada.
- **Limpieza de invitados** (comando diario, encargado por el `tick`):
  - borra sesiones caducadas o revocadas hace más de 7 días;
  - marca como caducados los códigos vencidos;
  - elimina **solo** invitados abandonados y vacíos (más de 30 días, sin citas, conversación, avisos ni perfil, sin código vigente y sin sesión vigente).
  - **No borra citas ni historial y no impide recuperar el acceso.**
- **Identidad, permisos y transacciones:** siempre en la API. n8n usa la credencial de servicio (scope `scheduler`) y nunca decide la identidad.

### E · Comprobante PDF
- **Generación:** tras confirmar, el comando `receipt.render` genera el PDF con **datos verificados leídos de PostgreSQL al generar**: referencia, paciente, especialidad, médico, centro, fecha y hora, duración, estado, versión de la cita, número de comprobante, huella SHA-256 de los datos y `correlation_id`.
- **Generador propio** PDF 1.4 (`modules/receipts/pdf.ts`), sin dependencias nuevas: Helvetica con WinAnsi, que cubre el español.
- **Versionado:**
  - una reprogramación o un adelanto generan el comprobante **n.º 2** y el anterior queda «superseded»;
  - una cancelación anula todos los comprobantes («void»);
  - si la cita ya cambió cuando se ejecuta el comando, el comprobante queda superado: no se genera uno con datos viejos.
- **Descarga:**
  - el PDF se guarda en la base (privado; nunca en Git ni en logs);
  - `GET /appointments/{id}/receipt.pdf` exige la sesión del paciente y que la cita sea suya: otro paciente recibe 404 y sin sesión 401;
  - Gradio lo sirve en `/comprobante/{id}` con la cookie HttpOnly.
- **Fallos:** la cita sigue confirmada. Tras 5 intentos el comprobante queda «failed» y el dueño puede pulsar «Reintentar» en Mis citas, que vuelve a encargar el comando.
- **En la interfaz:** la tarjeta de Mis citas muestra el estado real: «Generando comprobante…», «Descargar comprobante n.º N (PDF)» o «Reintentar».

## Pruebas y evidencias

| Prueba | Resultado |
|---|---|
| API (Vitest) `commands-receipts.test.ts` (n8n simulado) | 8/8: `correlation_id`, confirmación duplicada, n8n caído con lease vencido, ejecución idempotente, rama equivocada, permisos, limpieza segura, PDF y propiedad, reprogramación n.º 2, cancelación, fallo hasta «dead» y reintento |
| **Comprobación real con n8n** (`scripts/orchestration-check.mjs`) | **Todas superadas** (detalle abajo) |
| Interfaz (Playwright) | Reservar → «Mis citas» → descargar `comprobante-SC-…-n1.pdf` |
| Revisión visual del PDF | `docs/evidencias/comprobante/comprobante-real-n2.png` y `comprobante-muestra.png`, convertidos con `sips` (incluido en macOS) |

Detalle de la comprobación real, en comprobacion-real.md (carpeta de evidencias):
- PDF listo en 507 ms tras confirmar, con el `correlation_id` de la confirmación en la ejecución de n8n #1933;
- n8n detenido: la cita queda confirmada y el comando espera; al reiniciar se procesa solo (41 s);
- n8n que cae después de reclamar: el lease vence (120 s) y n8n lo reintenta (2.º intento);
- reprogramación: n.º 2 listo y n.º 1 superado;
- recordatorio (rama 5b) y limpieza (rama 5c) ejecutados por n8n.

## Limitaciones

- **PDF:** el generador es mínimo (texto, líneas y rectángulos, sin logotipo en imagen ni código QR). No se usa ReportLab porque no está instalado y no se autorizaron componentes adicionales.
- **Ejecuciones de n8n:** el disparador de recuperación (cada 30 s) genera ejecuciones aunque no haya comandos. n8n poda el historial según su configuración por defecto.
- **Calendario:** sigue en su workflow propio sin publicar (Google Calendar real pendiente).
- **Fuera de la orquestación:** audio e imágenes no están implementados.
- **Fallos del PDF:** en la comprobación real no se provocó un fallo de generación. El camino fallo → «dead» → reintento está probado con n8n simulado (integración) y el reintento desde la interfaz.
