# Decisiones de implementación

Registro de contradicciones entre documentos, cambios al diseño de [especificacion-sistema.md](especificacion-sistema.md) y decisiones tomadas durante la implementación. Orden de prevalencia: encargo del equipo (23-oct) → [referencias-y-viabilidad.md](referencias-y-viabilidad.md) → especificación → [arquitectura.md](arquitectura.md) → PDF de la raíz.

## 1. Contradicciones detectadas y cómo se resolvieron

| # | Contradicción | Resolución |
|---|---|---|
| C1 | La especificación §2 y §13 propone un AI Agent de n8n con OpenAI GPT-4.1 mini; referencias-y-viabilidad.md fija Ollama local como candidato inicial y OpenAI como opcional. | Prevalece referencias-y-viabilidad.md: Ollama local con un modelo pequeño medido en la entrega 2. OpenAI solo como alternativa configurable y desactivada sin presupuesto autorizado. |
| C2 | El orden de entregas de la especificación §11 y del encargo (estadísticas antes que Gradio) difiere del encargo del 23-oct (Gradio en la entrega 2 y estadísticas en la 3). | Se sigue el encargo del 23-oct: 1 base y agenda, 2 Gradio y conversación, 3 API de Norman, 4 automatizaciones, 5 verificación. |
| C3 | La especificación §6 dice que n8n confirma intenciones («confirmación determinista de n8n con token y remitente»); también exige que el backend de Gradio valide la sesión con la API en cada operación. | Hay dos caminos de confirmación con las mismas reglas: (a) el backend de Gradio con la sesión del paciente (entrega 1); (b) n8n con una credencial de servicio de scope `bot`, actuando sobre una actualización entrante cuyo paciente fijó la API al recibirla (entrega 2). El modelo nunca recibe el token de confirmación. |
| C4 | El esquema mantiene campos de Telegram (`external_chat_id`, `provider_message_id`, `delivery_failed`), pero Telegram queda fuera del MVP. | `channel_identities.channel` solo admite `gradio`. Los campos se conservan nulables por compatibilidad. En la bandeja web, «enviar» significa publicar en PostgreSQL, así que `delivery_failed` solo aparece si falla esa escritura. |
| C5 | La especificación §2 incluye Caddy (HTTPS); el desarrollo es solo local. | El proxy se prepara en la entrega 5 como parte del despliegue documentado. En local, los puertos se publican solo en `127.0.0.1`. |
| C6 | La especificación §5 rechaza reservas con «oferta pending no vencida», pero entre el rechazo de una oferta y la siguiente el slot quedaría público. | Un slot con ronda `open` no es reservable públicamente (regla más estricta). Al cerrarse la ronda (`exhausted`/`closed`) vuelve a estar disponible. |
| C7 | La especificación §7 pide disponibilidad por `doctor_service_id`; el bot necesita buscar por especialidad («quiero cardiología»). | `GET /availability` acepta `doctor_service_id`, `doctor_id` o `specialty_id`, más `center_id`. Al menos uno es obligatorio. |
| C8 | La especificación §10 sitúa las pruebas en `tests/`; las dependencias de Node viven en `apps/api`. | Las pruebas de la API van en `apps/api/test/`. `tests/` se reserva para e2e y la batería conversacional (entregas 2 y 5). |

## 2. Cambios al modelo de datos (migración 0001)

- **`appointments.starts_at` / `ends_at`**: copia del intervalo del slot vigente, mantenida por un trigger. Permite la restricción `EXCLUDE` que impide en PostgreSQL dos citas activas solapadas del mismo paciente, además de la validación de la API. Los tiempos de un slot son inmutables (otro trigger) para que la copia no diverja.
- **`slots_no_overlap`**: la exclusión GiST por médico y `tstzrange` solo se aplica a slots `open`. Un slot bloqueado conserva su historia sin impedir regenerar la agenda. Se añadió también `UNIQUE (doctor_service_id, starts_at)` para que la generación diaria sea idempotente.
- **`schedule_exceptions.reason`**: enumerado administrativo (`absence`, `holiday`, `training`, `other`) en lugar de texto libre, para no guardar texto clínico.
- **`appointments.source_channel`**: admite `gradio`, `api`, `operator` y `seed` (la especificación solo menciona `gradio`) para distinguir el origen de las reservas en las estadísticas.
- **`appointment_events`**: añade `appointment_version`, `from_starts_at`/`to_starts_at`, `status_before`/`status_after` y `reason_code`, para reconstruir cambios aunque el slot se bloquee después (referencias-y-viabilidad §4). Es de solo inserción (trigger).
- **`offer_rounds`**: añade `trigger_event`, `window_seconds`, `demo_mode`, `close_reason` y `closed_at`. El modo demo queda registrado en cada ronda y no altera la regla normal.
- **`advance_offers`**: añade `token_hash` (callback ligado al receptor), `candidate_rank`, `offered_at` y `close_reason`.
- **`action_intents`**: añade `appointment_id`, `appointment_version` y `slot_id` como columnas con FK (no solo dentro del JSON), además de `consumed_at`. `conversation_id` es nulable para las intenciones creadas fuera del chat.
- **`inbound_updates.patient_id`**: la API fija el paciente al recibir el mensaje desde la sesión autenticada. n8n no puede elegir la identidad.
- **`idempotency_records.status`**: solo `completed`. La respuesta se guarda en la misma transacción que la operación y las peticiones concurrentes con la misma clave se serializan con `pg_advisory_xact_lock`. No quedan registros «en curso» huérfanos tras una caída.
- **`calendar_sync`**: `binding_id` es nulable y hay un estado `disabled` (médico sin calendario vinculado). `external_event_id` es determinista: `sc` + UUID hexadecimal, válido como ID de Google Calendar (base32hex).
- **`notifications`**: añade `title`, `body` y `read_at` (este último ya previsto en la especificación §6).
- **`patient_accounts` / `patient_sessions`**: según la especificación §6. Las sesiones usan un token Bearer opaco (`pat_…`) guardado como hash SHA-256: el consumidor es el backend de Gradio (servidor), no el navegador. El panel de Norman usará cookies HttpOnly (entrega 3).

## 3. Reglas transaccionales implementadas

- Orden de bloqueo estable: paciente → intención → cita → slots (por id). Los interbloqueos o fallos de serialización se reintentan hasta 3 veces.
- La disponibilidad se revalida bajo bloqueo con `clock_timestamp()` (tiempo del servidor) en búsqueda, intención y confirmación, incluidos la anticipación mínima y el horizonte.
- Toda confirmación exige `Idempotency-Key`. La misma clave con el mismo cuerpo devuelve la respuesta guardada (también los errores 4xx). La misma clave con otro cuerpo devuelve 409.
- Una intención consumida devuelve su resultado original. Una nueva intención invalida las pendientes del paciente. Las intenciones caducan a los `INTENT_TTL_SECONDS` (600 s por defecto).
- Reprogramar mantiene el ID de la cita, mueve `slot_id` y sube la versión. Cualquier fallo revierte toda la transacción y conserva la cita original.
- Cancelar dos veces devuelve `already_cancelled` sin nuevos eventos ni avisos.
- En la misma transacción que la cita se crean: el evento, el evento analítico, el aviso en bandeja, `calendar_sync` con el trabajo `calendar.sync`, y los recordatorios a 24 h y 1 h (solo si aún son futuros). Cancelar o reprogramar anula los recordatorios anteriores. Ninguna llamada externa ocurre dentro de la transacción.

## 4. Versiones fijadas

| Componente | Versión | Nota |
|---|---|---|
| Node.js | 24.22.1 (imagen `node:24.22.1-alpine3.24`) | LTS «Krypton» |
| PostgreSQL | 18.6 (imagen `postgres:18.6-alpine3.24`) | `btree_gist` es extensión de confianza (la crea el propietario de la base) |
| Fastify | 5.12.7 | con `@fastify/swagger` 9.9.2, `@fastify/rate-limit` 11.2.1, `@fastify/cors` 11.3.1 |
| TypeBox | `typebox` 1.4.3 + `@fastify/type-provider-typebox` 6.3.0 | |
| pg | 8.23.1 | |
| TypeScript | 7.0.2 | solo comprobación de tipos y compilación |
| Vitest | 5.0.5 | |
| Redocly CLI | 2.71.0 | lint del contrato OpenAPI 3.1 |

## 5. Entrega 2: conversación, Gradio y n8n

### Separación explícita de responsabilidades

| Capa | Qué hace | Qué no hace |
|---|---|---|
| Modelo local (Ollama) | Clasifica la intención y extrae entidades en JSON. La salida está restringida con el parámetro `format` (esquema JSON) y usa `temperature: 0`. | No ve IDs, horarios, pacientes ni tokens. No responde al paciente. No confirma nada. |
| Validación y anclaje (API) | Valida el JSON con un esquema estricto (sin campos extra). Acepta especialidad, franja horaria y referencia de cita solo si el texto del paciente las respalda (tolera errores tipográficos). Resuelve las fechas de forma determinista. | |
| Máquina de estados (API) | Consulta disponibilidad real en PostgreSQL, pide aclaraciones, prepara propuestas y redacta las respuestas con plantillas a partir de datos de la base. | No ejecuta reservas ni cambios. |
| Gradio (backend) | Muestra opciones y, al pulsar **Confirmar**, prepara la intención y la confirma con la sesión del paciente y una `Idempotency-Key`. | No contiene reglas de agenda. |
| n8n | Recibe el aviso de mensaje nuevo (webhook autenticado), reclama con lease, llama a Ollama con la petición que construye la API, entrega el resultado o el error, y recupera pendientes cada minuto. | No escribe en tablas de negocio ni decide operaciones. |

Cada respuesta guarda su **modo**:

- `ai`: intención extraída por el modelo y ejecutada por reglas.
- `deterministic`: botón o menú, sin modelo.
- `fallback_menu`: el modelo falló, devolvió una salida inválida o no estaba disponible.
- `system`: resultado de una operación leído de PostgreSQL.

La interfaz muestra ese modo bajo cada mensaje. El menú guiado **no** cuenta como evidencia de que la IA funciona.

### Decisiones

- **D1. Extracción estructurada en lugar de un AI Agent con herramientas.** La especificación §3 proponía un AI Agent de n8n con herramientas; referencias-y-viabilidad.md permite la alternativa de extracción y máquina de estados. Se eligió la extracción desde el inicio porque, con modelos pequeños en CPU, cada llamada a herramienta implica otra generación completa (más latencia) y el modelo decidiría el orden de las operaciones. **No se ejecutó una batería con agente y herramientas**, así que no se afirma que ese enfoque sea inviable; solo que no se midió.
- **D2. La API construye la petición al modelo.** El prompt está versionado (`PROMPT_VERSION`) y es el mismo en producción y en la evaluación. n8n la reenvía tal cual; la URL de Ollama y el tiempo máximo vienen en la respuesta de `/internal/updates/claim`. Así no hay secretos ni prompts duplicados dentro del workflow.
- **D3. Las acciones de botón no pasan por n8n ni por el modelo.** La API las procesa de forma síncrona y determinista. El workflow de *callbacks* de la especificación §9 no hace falta en el canal web, porque la confirmación es una llamada HTTP autenticada del backend de Gradio.
- **D4. La propuesta nunca contiene tokens.** El backend de Gradio prepara la intención solo cuando el paciente pulsa **Confirmar**, y la confirma en ese mismo momento. El token no se guarda en claro en ninguna tabla ni llega al navegador o al modelo.
- **D5. "Sí" escrito en el chat no confirma.** Se responde pidiendo pulsar el botón.
- **D6. Memoria persistente.** El estado estructurado se guarda en `conversations.state` y el historial en `messages`. El resumen lo genera la API de forma determinista, no el modelo. El prompt recibe los últimos 4 turnos.
- **D7. Serialización y recuperación.** Hay un lease por actualización y por conversación, y no se reclama un mensaje mientras haya otro anterior pendiente en la misma conversación. Los leases vencidos se recuperan con el disparador de n8n que corre cada minuto. Un `ack` con un lease antiguo se rechaza (409). Si se agotan los intentos de infraestructura (3), se responde con el menú.
- **D8. Normalización de la salida.** `option_number: 0` se convierte en `null` (los modelos pequeños escriben 0 en lugar de null) y las cadenas vacías en `null`. Cualquier otra desviación del esquema se trata como fallo.
- **D9. Credenciales de n8n.** El servicio `n8n-import` las genera en tiempo de importación desde `.env` (n8n las cifra con `N8N_ENCRYPTION_KEY`); los JSON versionados solo las referencian por nombre e ID. Los workflows se publican con `n8n publish:workflow` (n8n 2.x). `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`.
- **D10. Ollama en Docker solo con CPU (perfil `ai`).** Se acerca más al VPS que Ollama nativo con GPU (Metal), pero la CPU del Mac no equivale a una vCPU de Contabo. **Las latencias medidas en local no permiten concluir que el sistema sea viable en el VPS.**

### Versiones fijadas (entrega 2)

| Componente | Versión |
|---|---|
| n8n Community | `n8nio/n8n:2.44.6` (etiqueta `stable` al 23-oct-2026) |
| Ollama | `ollama/ollama:0.40.6` |
| Python / Gradio | `python:3.12.13-slim-bookworm`, `gradio==6.30.0`, `httpx==0.28.1`. Árbol completo en `apps/demo-gradio/requirements.txt` |

## 6. Entrega 3: API del panel

- **E1. Sesión administrativa por cookie, no por token en JavaScript.**
  - `POST /auth/login` emite `sc_admin` (HttpOnly, `SameSite=Lax`, `Secure` según `COOKIE_SECURE`) y `sc_csrf` (legible).
  - Las escrituras exigen `X-CSRF-Token`, cuyo hash se guarda en `admin_sessions.csrf_hash` y se compara en tiempo constante.
  - El token de sesión no viaja en el cuerpo de la respuesta.
  - Las sesiones de paciente (Bearer) y las administrativas (cookie) no se mezclan: cada guarda exige su tipo de principal.
- **E2. Roles:** `viewer` (estadísticas e integraciones), `operator` (más traspasos, asistencia y cola) y `admin`. La comprobación es por rango mínimo.
- **E3. CORS:** lista blanca `CORS_ALLOWED_ORIGINS` con credenciales, métodos `GET/POST/PATCH` y cabeceras `content-type`, `x-csrf-token`, `idempotency-key` y `x-request-id`. Un origen no autorizado no recibe cabeceras CORS. En el despliegue se recomienda servir el panel bajo el mismo origen.
- **E4. Filtros de fecha de las estadísticas:** fechas locales `AAAA-MM-DD` con `[from, to)`, en lugar de instantes RFC 3339. Encajan con «día local» de la especificación §8 y facilitan conciliar las series diarias. Las respuestas siguen usando RFC 3339 con desplazamiento en `generated_at`.
- **E5. Dos cohortes separadas:** las operaciones se cuentan por fecha del evento; la agenda, la ocupación y la asistencia, por fecha del slot. Toda tasa se devuelve con numerador y denominador.
- **E6. Atribución de búsquedas a filtros:** solo cuentan para un filtro las búsquedas hechas por ese servicio o por esa especialidad. Las demás solo cuentan en el total.
- **E7. Aclaraciones:** `/stats/conversation` cuenta como aclaración toda respuesta que pide un dato con opciones (fecha, especialidad o cita), separada de las respuestas directas. Es la base para medir la mejora conversacional pendiente.
- **E8. Asistencia:** solo un `operator`, solo tras el inicio, con `expected_version`, `Idempotency-Key` y evento `completed`/`no_show` con `actor_type = operator`.
- **E9. Contrato y artefactos:** el OpenAPI se genera desde las rutas. Los ejemplos de `contracts/examples/` son respuestas reales generadas por `scripts/generate-examples.mjs`, con los tokens sustituidos por marcadores. La colección Postman se validó con Newman 6.2.1 (12/12 aserciones).
- **E10. Contraseñas de demostración:** usuarios administrativos ficticios en el dominio reservado `.test`, con contraseña común `SEED_ADMIN_PASSWORD` (mínimo 8 caracteres; en la demostración local, `12345678`, que el login muestra y rellena) solo para desarrollo local.

## 7. Entrega 3B: panel administrativo propio

- **P1. Cambio de responsabilidad.** El panel lo construye el equipo; los documentos de diseño se anotaron con este cambio.
- **P2. Prototipo HTML.**
  - El prototipo HTML inicial (no incluido en el repositorio público) es una demo del propio equipo: un único HTML sin dependencias ni licencia de terceros, con datos y reloj simulados en memoria.
  - Se conserva sin cambios. Del prototipo se toma solo el lenguaje visual (barra lateral, tarjetas de métricas, paleta neutra).
  - Su código no se reutiliza, porque el panel debe consumir datos reales.
- **P3. Tecnología.**
  - React 19 + Vite 8 + TypeScript + Chart.js 4 (MIT), compilados a estáticos.
  - Sin enrutador externo (enrutado por hash) y sin librería de componentes: menos dependencias y CSP estricta sin estilos ni scripts externos.
- **P4. Mismo origen.**
  - La API sirve el panel en `/panel/` con `@fastify/static`, CSP `default-src 'self'`, `frame-ancestors 'none'` y `nosniff`. La raíz redirige al panel.
  - La imagen Docker de la API compila el panel en una etapa previa (`PANEL_DIR`). Así el profesor no necesita Node.js para ejecutarlo.
- **P5. Permisos en dos capas:** el servidor exige el rol en cada endpoint y la interfaz oculta las secciones no permitidas.
- **P6. Mantenimiento sin borrar historial.**
  - Los catálogos se desactivan y las reglas se finalizan.
  - Solo se retiran ausencias futuras.
  - Cambiar reglas, ausencias o servicios ejecuta `reconcileSchedule`:
    - bloquea los slots futuros **libres** que ya no encajan (fuera de reglas, en ausencia, servicio inactivo o duración distinta);
    - reabre los bloqueados que vuelven a encajar;
    - genera los nuevos;
    - devuelve las **citas reservadas afectadas como conflictos, sin modificarlas**.
- **P7. Simulación (`dry_run=true`).** Ejecuta la misma transacción y la revierte. La interfaz siempre simula antes de confirmar.
- **P8. Auditoría.** `admin_audit_log` (solo inserción) registra el usuario, la acción, la entidad, el estado anterior y posterior, y el impacto.
- **P9. Idempotencia.** Las altas del catálogo no exigen `Idempotency-Key`: un alta duplicada choca con las restricciones únicas (409). Las ediciones son naturalmente idempotentes. La asistencia sí la exige.
- **P10. Funcionalidades no implementadas.** Las ofertas aparecen como «Pendiente (entrega 4)» con su explicación. Google Calendar muestra «Pendiente de credenciales». No se usan cifras estáticas.

## 8. Entrega 4: automatizaciones

- **A1. Ofertas en la transacción.** La ronda se abre en la misma transacción que libera el horario (cancelación, reprogramación o adelanto). Así no hay ventana en la que el horario quede público por error.
- **A2. Fallos de oferta que cambian estado.** Si la oferta resulta vencida o inválida, la transición (cerrar la oferta y ofrecer al siguiente) se **confirma** y después se responde 410/409. El ayudante de idempotencia ya no revierte ese efecto: el servicio devuelve el fallo en lugar de lanzarlo. Una oferta ya vencida responde siempre 410.
- **A3. Candidatos del mismo servicio** (médico, centro, especialidad y duración), como restricción deliberada del MVP (especificación §5).
- **A4. Canal web y token de la oferta.** La oferta se acepta con la sesión del paciente y `Idempotency-Key`. `advance_offers.token_hash` se conserva para canales futuros. En el canal web no existe `delivery_failed`.
- **A5. Recordatorios procesados por la API dentro del tick.** Solo escriben en la bandeja, sin llamadas externas. Se validan la versión y que la cita no haya empezado. n8n decide cuándo ejecutar el tick (cada minuto).
- **A6. Calendario.**
  - La cola durable es genérica (`/internal/jobs/*`, scope `calendar-sync`).
  - El estado deseado del evento se calcula **al reclamar**, con la versión vigente de la cita, y los trabajos obsoletos se reemplazan.
  - `synced_version` nunca retrocede.
  - Sin vínculo habilitado, el tick cierra los trabajos como «no configurado» (`calendar_sync.status = disabled`).
- **A7. Workflow de Google Calendar como borrador.** Se importa sin publicar (`meta.saludcita_publish = false`) porque falta la credencial OAuth y no se ha probado contra Google. `n8n-import.sh` solo publica los workflows marcados.
- **A8. Modo demo de ofertas.** `OFFERS_DEMO_MODE` cambia la ventana a `OFFER_DEMO_WINDOW_SECONDS`. Queda registrado por ronda y visible en el aviso; la regla normal de 1 h no cambia.

## 9. Entrega 5: verificación

- **V1. Aclaraciones con acciones concretas.** Ante una intención genérica con pistas en el texto, el asistente propone botones (`book_with`, menú) y marca la respuesta como `clarification`. Sin pistas, ofrece un menú de 4 acciones, nunca un saludo genérico. El saludo real sigue siendo directo.
- **V2. Evaluación en tres niveles.** Modelo, reglas (oráculo con n8n detenido) y sistema completo, con resultados clasificados como directo, aclaración útil o fallo según la batería congelada. Las correcciones posteriores a la evaluación no se presentan como resultado de esa batería.
- **V3. Instancias separadas.** `COMPOSE_PROJECT_NAME` y todos los puertos son configurables. `restore.sh` rechaza proyectos con volúmenes existentes.
- **V4. `btree_gist`.** La crea la primera migración como propietario (extensión de confianza), no el script de inicialización. Así `pg_restore` la recrea sin conflictos.
- **V5. Copias.** Volcado `pg_dump` en formato custom de ambas bases más `.env`, cifrados con AES-256-CBC y PBKDF2, con manifiesto y SHA-256. La frase de cifrado nunca se guarda en archivos.
- **V6. Despliegue.** Superposición `compose.prod.yaml` sin puertos publicados salvo Caddy, con límites de memoria y rotación de registros. Caddy bloquea `/api/v1/internal/*` y los webhooks de n8n desde fuera, y pide autenticación básica para el editor de n8n.

## 9B. Incremento A: sesión invitada segura

- **Acceso sin registro.** El servidor de Gradio (`apps/demo-gradio/server.py`, FastAPI) crea una sesión invitada en la API con su credencial de servicio `gradio-gateway` (scope `gateway`) y la guarda en la cookie `sc_device` (HttpOnly, SameSite=Lax, Secure con `COOKIE_SECURE`). Ni la credencial de servicio ni el token llegan a JavaScript.
- **Identidad.** El paciente sale siempre de la sesión validada por la API. n8n y el modelo reciben el `patient_id` ya resuelto; la identidad del canal es `p:<patient_id>`.
- **Recuperación.** Código `SCR-…` de 125 bits, guardado como SHA-256, 180 días, uno activo por paciente, de un solo uso (al canjearlo se emite otro, que se muestra una sola vez), revocable. Nombre, fecha de nacimiento, referencia de cita o `patient_id` **no** autentican. Errores genéricos (`invalid_recovery_code`) y límites por IP: 30 sesiones/hora y 5 canjes/15 min. El código se redacta en los logs (`req.body.code`) y nunca viaja en la URL.
- **Rutas /acceso/*** (recuperar, demo, salir): exigen la cabecera `x-saludcita-ui: 1` y Origin del mismo sitio; la IP del cliente solo se toma de `X-Forwarded-For` con `GRADIO_TRUST_PROXY_HEADERS=true` (detrás de Caddy).
- **Perfil mínimo.** Para reservar se piden nombre y fecha de nacimiento ficticios en el propio cuadro de confirmación; la API devuelve 409 `profile_required` si faltan.
- **Cuentas de demostración.** Se conservan (pestaña «Tu acceso») para pruebas y para la demo; el login administrativo sigue siendo obligatorio.

## 9C. Conversación natural, citas y acceso transparente

- **Dos llamadas al modelo, ambas orquestadas por n8n.** `interp-v1` (sin cambios) extrae la intención; `draft-v4` redacta el texto. La máquina de estados y la agenda siguen decidiendo; el modelo nunca elige horarios ni confirma.
- **Validación independiente de la redacción.** Expresiones prohibidas: números, días u horas, médicos, referencias, enlaces, afirmaciones de operaciones y contenido clínico. Si falla, se usa el texto determinista y se guarda `draft.rejected_reason`.
- **Mensaje citado.** `reply_to` (hasta 500 caracteres) es solo contexto: se añade al prompt de interpretación y de redacción. No autoriza nada.
- **Recuperación con código y fecha de nacimiento.** El código autentica; la fecha es una segunda comprobación. Un error devuelve una respuesta genérica, no consume el código y cuenta para el límite por IP. El código se intercepta en Gradio y nunca llega a la API de conversación.
- **Cookie tras recuperar dentro del chat.** Un handler de Gradio no puede fijar cookies, así que deja el token bajo un nonce aleatorio de 60 s y un solo uso, que el navegador canjea en `/acceso/activar` (misma cabecera propia y mismo origen).
- **Sin modo visible en el chat**, a petición del usuario. La trazabilidad queda en `messages.mode`, en `inbound_updates.result` y en las ejecuciones de n8n.

## 9D. Revisión correctiva previa al commit de A y B (24-oct-2026)

### Respuestas correctas antes que naturales
- **Fecha anclada.** La fecha del modelo (`date_phrase`) solo se usa si sus palabras aparecen en el mensaje del paciente (`groundedDatePhrase`). Corrige «hoy» o «mañana» inventados en «necesito cita para mi hijo».
- **Redacción por el modelo limitada.** Solo saludo, ayuda y negativa, y solo si la respuesta no lleva datos estructurados, aclaración ni sugerencias. Horarios, propuestas, resultados, aclaraciones y el texto de seguridad (9-1-1) se presentan siempre con el texto verificado, sin segunda llamada.
- **Validación más estricta,** que además compara con el catálogo: rechaza nombres de especialidades y médicos, lugares, precios, contactos y peticiones de datos personales. Aun así, **buscar palabras no garantiza exactitud**: en `reserved-v3` el validador aceptó 6 de 6 redacciones y la revisión manual solo consideró correctas 2 (errores gramaticales y respuesta en español a una pregunta en inglés).
- **Redacción desactivada por defecto** (`LLM_DRAFT_ENABLED=false`). Con o sin ella el resultado fue el mismo (27/29). Sin ella, la latencia visible baja (p50 1,8 s frente a 2,5 s) y los textos son correctos. Las respuestas sociales verificadas ahora son naturales: devuelven el saludo («¡Buenas tardes!») y responden a agradecimientos y despedidas. La rama de n8n se conserva y se activa con la variable.

### Recuperación y sesiones
- **Defensa en profundidad del código.** Además de interceptarlo en Gradio, la API sustituye cualquier `SCR-…` del texto y del mensaje citado por «[código de recuperación oculto]» antes de guardarlo o enviarlo a n8n o al modelo. Una burbuja que contiene el código no se puede citar. El cuerpo de `/gateway/recover` se redacta en los logs (`req.body.code`) y la analítica no guarda texto.
- **Bloqueo por código.** Tras 5 fechas de nacimiento incorrectas, el código se invalida (`too_many_attempts`, migración 0010). Esto se suma al límite por IP (5 canjes cada 15 min). El error es siempre genérico (`invalid_recovery_code`), exista o no el código.
- **Política de rotación.** Al canjear un código, ese código queda «usado», se crea una sesión `recovery` en el nuevo dispositivo y se emite un código nuevo, que se muestra una vez. Las sesiones de otros dispositivos siguen abiertas hasta «Cerrar sesión en otros dispositivos». Generar un código nuevo revoca el anterior (`rotated`).

### Interfaz
- **Campo de texto.** El indicador de progreso de Gradio (`.wrap.generating`) ya no se oculta: se le da el radio del campo, solo en `#sc-input`. Se protege con una prueba de regresión y capturas en `docs/evidencias/correccion/`.
- **IDs explícitos:** `#sc-chat`, `#sc-input`, `#sc-send`, `#sc-card`, `#sc-quote`, `#sc-kebab` y `#sc-tabs`. Se eliminaron las reglas de la estructura antigua (mensajes agrupados).
- **Selectores internos de Gradio 6.30.0 que siguen siendo necesarios** (Gradio fijado en `requirements.txt`): `.bubble-wrap`, `.message-row`, `.bot-row`/`.user-row`, `.message.bot`/`.message.user`, `.message-content`, `.avatar-container`, `.top-panel`, `.message-buttons`, `.wrap.generating`, `[role=tab]`/`.tab-container`, `.label-wrap` (acordeón) y `[data-testid=status-tracker]`. Los protege `tests/e2e/specs/estilos-contrato.spec.ts`, que falla si la estructura cambia.
- **Sonidos.** El clic por tecla es una preferencia independiente y está **desactivado por defecto** (menú ⋮). Envío y recepción siguen activos y se silencian con 🔊; ambas preferencias persisten solo en ese navegador.
- **Accesibilidad,** verificada con axe (WCAG 2 A/AA, temas claro y oscuro) y con pruebas de teclado:
  - contraste corregido en la cabecera, las pestañas, la cita y los textos sobre el fondo;
  - la conversación es desplazable con el teclado;
  - el menú cerrado es `inert`;
  - con movimiento reducido solo hay fundidos;
  - la mascota no recibe eventos.

### Pruebas aisladas sin debilitar límites
- Las pruebas de interfaz usan una instancia de Gradio aparte (`infra/compose.e2e.yaml`, puerto 7861, solo localhost, perfil `e2e`) que confía en `X-Forwarded-For`. Cada ejecución usa su propia IP de documentación (198.18.x.x). Los límites tienen los mismos valores; la instancia normal (7860) no confía en esa cabecera.
- Cada prueba usa una cuenta ficticia distinta (el login tiene un límite por cuenta de 10 cada 5 min).

### n8n: qué hace cada parte
- **El modelo** (llamado por n8n) solo extrae la intención y las entidades en JSON. Si la redacción está activada, redacta saludos y ayuda.
- **La API** decide: valida el JSON, ancla las entidades al texto, consulta la agenda real, aplica las reglas, prepara las propuestas y valida la redacción. **Nunca** confirma: las confirmaciones solo llegan con el botón del paciente.
- **n8n** coordina: recibe el aviso, reclama con lease, llama al modelo, entrega el resultado, ramifica (¿redactar?) y reintenta. Los 8 pasos se ejecutan de verdad. Con la redacción desactivada, la rama IF va por «no» y los pasos 7 y 8 no se ejecutan, lo que queda visible en cada ejecución. `correlation_id` es el `update_id`.

## 9E. Conversación abierta y multilingüe (24-oct-2026)

- **Cuatro capas:** (1) conversación general generada por el modelo y validada, (2) guía documentada del servicio ([guia-servicio.md](guia-servicio.md)), (3) agenda verificada por la API y (4) operaciones solo con el botón «Confirmar».
- **Enrutamiento:** `interp-v2` añade las intenciones `chat` y `service_info`. Reglas deterministas corrigen al modelo:
  - una «pregunta clínica» sin pistas de salud se trata como charla;
  - un mensaje vago produce una aclaración con opciones;
  - la charla con pistas de cita produce una aclaración.
- **Generación:** `converse-v1` es la segunda llamada vía n8n y solo se usa en las capas 1 y 2 y en la frase de empatía. Recibe el historial (4 turnos), la guía (compacta para charla, completa para preguntas del servicio), la gestión pendiente y si toca orientar hacia la agenda (primer turno de charla y luego cada 4, para no insistir).
- **Validación** de cada texto generado: horas, referencias, operaciones afirmadas, dosis y medicamentos, fuentes externas, petición de datos sensibles, médicos fuera del catálogo e idioma. La empatía debe ser una frase sin consejos. Si el texto no pasa, se usa el texto verificado; no hay respuestas fijas presentadas como generadas. La prueba `generated: true` distingue ambos casos.
- **Idioma** (`lang.ts`), determinista:
  - una petición explícita fija el idioma hasta otra petición;
  - un mensaje con señal clara cambia el idioma;
  - los mensajes breves conservan el idioma actual.
- **Textos de agenda en inglés:** plantillas verificadas (`localize.ts`) que convierten las fechas de nuestro propio formato sin traducir nombres ni referencias. En otros idiomas, la agenda se muestra en español con un aviso.
- **Retomar:** la charla no cambia el estado de la cita. Si hay una gestión en curso, se ofrece «Continuar con mi cita» (acción `resume`), que vuelve a mostrar los mismos horarios o la misma propuesta.
- **Sin cambios de identidad, permisos ni reglas por conversación libre:** una propuesta solo se confirma con el botón. Probado en `converse.test.ts`.
- **Variable:** `LLM_CONVERSE_ENABLED`, activada por defecto; si se desactiva, solo se usan textos verificados. Sustituye a la redacción anterior (`draft.ts`), que se eliminó.

## 9F. Orquestación con comandos durables y comprobante PDF (24-oct-2026)

- **Cómo se reparte el trabajo:** n8n coordina (reclama, enruta, reintenta) y la API ejecuta cada comando en una transacción. Así identidad, permisos y reglas no salen de la API y la ejecución de n8n refleja trabajo real.
- **Un endpoint por tipo** (`/internal/commands/{id}/receipt|reminder|guest-cleanup`): las ramas del Switch no son decorativas; un comando no se ejecuta por una rama ajena.
- **Aviso inmediato** con un hook `onResponse` de Fastify tras confirmar, aceptar un adelanto o reintentar, y **recuperación cada 30 s**. El aviso no es necesario para la entrega, solo reduce la espera.
- **Migración 0011:** `outbox_jobs.correlation_id` y la tabla `appointment_receipts`, con un comprobante por versión de la cita y una restricción que impide marcarlo «ready» sin PDF ni huella.
- **PDF sin dependencias:** ReportLab no está instalado y se pidió no instalar componentes. El generador propio produce PDF 1.4 válido; se revisó convirtiéndolo a imagen con `sips` (macOS).

## 10. Pendiente en entregas posteriores

- Mejora conversacional ante intención incierta: aclaración con acciones concretas, medida con la batería reservada `reserved-v2` (ver evaluacion-ia-local.md §5).
- Medición del modelo y del sistema completo en el VPS de Contabo.
- Activación y prueba real de Google Calendar con una cuenta de prueba (docs/automatizaciones.md).
