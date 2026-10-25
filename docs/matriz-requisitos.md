# Matriz de requisitos (cierre de etapa, 24-oct-2026)

Única matriz del proyecto. Arriba, el estado al cerrar la etapa; debajo, el detalle por requisito.

> **Estado (24-oct-2026):** el sistema funciona de punta a punta en local y en un VPS con HTTPS, con conversación natural
> y multilingüe (Groq, con respaldo local). Siguen pendientes la interfaz multilingüe y, bloqueados por dependencias, voz,
> OCR y Google Calendar real.

## Estado al cerrar la etapa

### Funcional y verificado

| Área | Evidencia |
|---|---|
| Agenda: disponibilidad real, reservar, cancelar, reprogramar, ofertas en cascada, recordatorios, sin dobles reservas | Pruebas de la API (200/200), demo trazable, prueba de humo |
| Operaciones del paciente solo por orden durable que ejecuta n8n (`appointment.confirm`, `offer.answer`); sin rutas directas; idempotencia, `correlation_id`, vencimiento a 120 s y recuperación tras reinicios y leases vencidos | confirmacion-via-n8n.md (carpeta de evidencias), correcciones-revision.md (carpeta de evidencias) |
| Interfaz honesta ante resultados inciertos («no pude verificar»), una orden a la vez, código de recuperación también tras reserva diferida | 12 pruebas de interfaz (`apps/demo-gradio/tests`) |
| Ramas reales de la conversación visibles en n8n (Switch de 9 ramas decidido por la API; otra rama → 409) | ramas-conversacion.md (carpeta de evidencias) |
| Información del servicio con datos verificados (horarios de consulta, precios, seguros, pagos, contacto, comprobantes, normas, funciones) y reconocimiento de lo no registrado | Pruebas de integración; v6: 0 afirmaciones inventadas |
| Comprobante PDF versionado, entregado en el chat y en «Mis citas» | Demo real 24-oct: Gradio → n8n (#2924 disponibilidad, #2928 operación) → «Confirmar» (#2930) → cita SC-GJPVC7 → PDF (#2931), mismo `correlation_id` |
| Sesión invitada, recuperación, accesibilidad (axe WCAG AA), estilo de mensajería | Incrementos A y B |
| Instalación desde `git clone`, copia de seguridad y restauración | Verificación integral y reproducibilidad (sin cambios que las afecten salvo migraciones 0012–0013, aplicadas en la instalación local) |
| Conversación natural (D1) y multilingüe (D2) | Con Groq `gpt-oss-120b` (respuestas redactadas a partir de datos verificados); con solo el modelo local la calidad es menor |
| Despliegue en Contabo | 24-oct-2026: VPS con HTTPS (Caddy), todos los servicios en Docker ([despliegue-contabo.md](despliegue-contabo.md)) |
| Documentos con datos personales | Revisados antes de publicar: actas y notas internas del equipo fuera del repositorio; pacientes, médicos, teléfonos y correos ficticios |

### Implementado con limitaciones

| Área | Limitación medida |
|---|---|
| Conversación abierta con qwen3:1.7b | v6: 17/24 turnos; 3 errores de interpretación (p. ej., «pásame el teléfono» → fuera de alcance) y 4 de infraestructura. No se declara cumplida (D1) |
| Multilingüe | Plantillas verificadas solo en español e inglés; otros idiomas con aviso y datos en español (D2). Interfaz solo en español (D3) |
| Suite de interfaz | Última ejecución 19/19; en ejecuciones anteriores 18/19: los fallos intermitentes coinciden con bloqueos de n8n por memoria; no se ampliaron tiempos de espera |
| Visualización en el editor de n8n | Verificado: *Executions* → ejecución terminada muestra resaltada la rama real (#2924: solo 7b de las 9 ramas) y la lista tiene «Auto refresh»; el detalle de una ejecución en curso se guarda paso a paso. No verificado: animación del lienzo con ejecuciones de producción |
| Panel administrativo | Portada operativa (hoy, próxima cita, actividad, alertas, disponibilidad) y actualización **en vivo por SSE** tras cada commit, verificada desde Gradio: 0,7–1,7 s del commit a la pantalla (panel-en-vivo.md (carpeta de evidencias)); análisis por periodo; axe WCAG AA en claro y oscuro. Faltan detalle e historial de citas, gestión de ofertas y avisos individuales, usuarios y roles (sin API). Conversación e integraciones con actualización periódica, no en vivo |
| Estabilidad de memoria | **Resuelto en el servidor:** el modelo principal es Groq (nube) y el local (`qwen3:1.7b`) queda como respaldo en un VPS de 23 GB. En un portátil con poca memoria para Docker, el modelo local puede ser lento ([instalacion.md](instalacion.md)) |

### Pendiente o bloqueado

| Área | Estado |
|---|---|
| Interfaz multilingüe (D3) | Pendiente: los botones y menús del chat están en español; las respuestas sí siguen el idioma del paciente |
| Voz (F, G) y OCR (H) | Bloqueados: componentes sin autorizar |
| Google Calendar real | Bloqueado: workflow importado sin publicar; faltan credenciales y prueba real |

Leyenda del detalle: ✅ verificado · 🟡 parcial · ⏳ pendiente · 🔒 bloqueado por dependencia · ➕ mejora opcional.

## Requisitos del encargo original

| Requisito | Evidencia | Resultado | Pendiente |
|---|---|---|---|
| 20 solicitudes concurrentes → una cita activa | `apps/api/test/integration/booking.test.ts`; la prueba falla si se quita el bloqueo | ✅ | — |
| Reintento con la misma clave → mismo resultado | `booking.test.ts`, `admin-stats.test.ts`, `offers-jobs.test.ts`, prueba de humo | ✅ | — |
| Un paciente no consulta ni modifica citas ajenas | Pruebas de integración y de humo; R2-O02 muestra solo las propias | ✅ | — |
| Confirmación vencida o antigua no modifica | `booking.test.ts` (410 / 409 por versión) | ✅ | — |
| Reprogramación fallida conserva la reserva | `booking.test.ts` | ✅ | — |
| Carrera aceptación/vencimiento sin inconsistencias | `offers-jobs.test.ts` (aceptación y dos ticks en paralelo) | ✅ | — |
| Reinicio conserva datos y recupera trabajos | `evidencias/entrega-4/reinicio-recuperacion.txt`; restauración (`entrega-5/backup-restauracion.md`) | ✅ | — |
| Calendario converge al estado vigente | API probada con un cliente simulado (`offers-jobs.test.ts`) | ⛔ | **Sin Google real.** Un cliente simulado no es una integración terminada ([google-calendar.md](google-calendar.md)) |
| Estadísticas coinciden con datos persistidos | `admin-stats.test.ts`; SQL de `docs/estadisticas.md` igual que la API | ✅ | — |
| El bot nunca confirma una cita inexistente | `conversation.test.ts` (`intent_result`); 0 citas sin botón en todas las baterías | ✅ | — |
| Otra persona reproduce la demo con el README | `evidencias/entrega-5/instalacion-limpia.md` (copia limpia, volúmenes nuevos, build sin caché) | 🟡 | Repetir con `git clone` real tras el commit de la entrega 5 |
| Ofertas secuenciales y cascada (≥ 2 aceptaciones) | `offers-jobs.test.ts`, `scripts/e2e-offers-n8n.mjs`, demo trazable | ✅ | — |
| Recordatorios sin versiones canceladas | `offers-jobs.test.ts`, tick de n8n | ✅ | Solo bandeja web (sin SMS ni correo, por diseño) |
| Conversación con IA local (Ollama) | `docs/evaluacion-ia-local.md` (reserved-v3 27/29 en gestión de citas; conversación abierta `reserved-v5` 31/47) | 🟡 | Modelo de 1,7 B débil en intención; solo español; modelos mayores sin evaluar por memoria |
| Aclaraciones ante intención incierta | reserved-v2 en tres niveles; aclaraciones contadas aparte | ✅ (medido) | 3 fallos documentados (R2-A01, C01, O02) |
| Panel administrativo propio | Entrega 3B; Playwright (permisos y agenda); revisión escritorio y móvil | ✅ | — |
| Pruebas de interfaz de recorridos críticos | `tests/e2e`: 19/19 en instalación limpia (sesión invitada, recuperación, comprobante, contrato de estilos, axe, teclado) | ✅ | Límites de seguridad: ≤ 3 ejecuciones cada 5 min (login del panel) y ≤ 2 cada 15 min (canje de códigos por IP) |
| Backup y restauración probados | `scripts/backup.sh`, `restore.sh`, `verify-restore.sh`; `evidencias/entrega-5/backup-restauracion.md` | ✅ | Ensayo periódico en el despliegue |
| Workflows n8n exportados e importables en instancia limpia | `workflows/n8n/*.json`; instalación limpia: 3 importados, 2 publicados | ✅ | — |
| Demo trazable (n8n y Ollama reales) | `evidencias/entrega-5/demo-trazable.md` (12/12, ejecuciones #351/#352) | ✅ | — |
| Vínculo de calendario por médico reproducible | Panel → Calendarios (auditado), `cli.js calendar-bind`, prueba en `maintenance.test.ts` | ✅ | La sincronización real sigue pendiente |
| Guía de despliegue Contabo | `docs/despliegue-contabo.md`; `compose.prod.yaml` y Caddyfile validados | 🟡 | **No desplegado** (por instrucción) |
| Medición del modelo en Contabo | — | ⛔ | Pendiente tras el despliegue |
| Sin secretos ni datos personales en Git | Revisión por patrón de los 8 secretos de `.env` y de tokens en cada commit | ✅ | — |

## Ampliación de alcance del 23-oct (incrementos A–I) — actualizado el 24-oct

| Requisito | Estado | Evidencia y motivo |
|---|---|---|
| A. Sesión invitada segura y recuperación | ✅ | [incremento-a.md](entregas/incremento-a.md). Código + fecha de nacimiento, bloqueo tras 5 fallos, código redactado en la API |
| B. Chat tipo mensajería, robot, sonidos, accesibilidad | ✅ | [incremento-b.md](entregas/incremento-b.md). Interfaz 20/20, axe WCAG AA en tema claro y oscuro |
| C. Orquestación completa en n8n (comandos durables, `correlation_id`) | ✅ Para todas las operaciones de agenda | [incremento-c-e.md](entregas/incremento-c-e.md). **Pasan por n8n:** interpretación y redacción de cada mensaje (Conversación → Ollama), **confirmación de reservas, cancelaciones y reprogramaciones** (orden `appointment.confirm`), **respuestas a adelantos** (orden `offer.answer`), comprobante PDF, recordatorios, limpieza de invitados y planificador ([§ Confirmación](#confirmación-y-n8n)). Comprobación real con caída y reinicio de n8n, lease vencido e idempotencia. Audio e imagen no existen, así que no se orquestan |
| D1. Conversación natural, contextual y abierta | ⏳ **No cumplido** | v5 (histórico): 31/47 turnos y 2 afirmaciones falsas. v6 (independiente, tras separar la información del servicio): 17/24 turnos, 0 afirmaciones inventadas, 3 errores de interpretación, 4 de infraestructura y 1 respuesta parcial engañosa corregida después ([evaluacion-ia-local.md §14](evaluacion-ia-local.md)) |
| D2. Conversación multilingüe (responder en el idioma del usuario) | ⏳ **No cumplido** | Español 16/20 e inglés 7/11 útiles; portugués 1/3, francés 0/2, italiano 1/2, alemán 0/2. No se declara soporte fiable de ningún idioma salvo, parcialmente, español e inglés |
| D3. **Interfaz multilingüe** (botones, menús, pestañas, tarjetas) | ⏳ **Pendiente** | Solicitada en el requisito prioritario de conversación abierta. Hoy la interfaz solo está en español; las respuestas de agenda tienen plantillas verificadas en español e inglés |
| E. Comprobante PDF | ✅ | [incremento-c-e.md](entregas/incremento-c-e.md). Comando durable, versionado, descarga solo del dueño, reintento, revisión visual |
| F. Audio de entrada (transcripción local) | 🔒 | Necesita autorizar componentes (p. ej., faster-whisper) y medir memoria; con 5,8 GiB compartidos es muy justo |
| G. Voz de respuesta | 🔒 | Mismo caso (p. ej., Piper o Web Speech del navegador), sin autorizar |
| H. Imágenes administrativas y OCR | 🔒 | Necesita autorizar componentes (p. ej., Tesseract) |
| I. Verificación integral | 🟡 Hecha para lo implementado | [verificacion-integral.md](entregas/verificacion-integral.md): API 172/172, interfaz 19/19 en instalación limpia, restauración idéntica, orquestación real. `git clone` real superado (instalacion-git-clone.md (carpeta de evidencias)). Pendiente: decidir qué documentos con datos personales se publican |
| Google Calendar real | 🔒 | Necesita la cuenta de prueba y la credencial OAuth del equipo ([google-calendar.md](google-calendar.md)) |
| Despliegue y medición en Contabo | 🔒 | Decisión del equipo: posponer |
| Modelo mayor (qwen3:4b/8b) | ➕ | Mejoraría D1 y D2; el usuario decidió mantener qwen3:1.7b y la memoria actual |
| Logotipo o QR en el PDF | ➕ | |


## Confirmación y n8n

Cambio implementado el 2026-10-24 por decisión del equipo: n8n debe orquestar el flujo visible en la demostración.
Migración `0012_confirm_via_n8n`, comando durable `appointment.confirm` y rama «5 · Confirmar cita» del workflow «Comandos durables».

| Paso | Ahora |
|---|---|
| El paciente pulsa «Confirmar» (reservar, cancelar o reprogramar) | Gradio → `POST /action-intents/:id/submit`: la API comprueba token, dueño y vigencia y **solo registra la orden** (202, `correlation_id`). No toca la agenda |
| Reclamar y ejecutar | n8n reclama la orden (aviso inmediato por webhook o disparador cada 30 s) y llama a `POST /internal/commands/:id/confirm` |
| Reservar, cancelar o reprogramar | La API revalida identidad, propiedad, horario y versión en su transacción; un rechazo de negocio (horario ocupado, versión cambiada) es un resultado, no un reintento |
| Comprobante PDF y recordatorios | La misma transacción encarga sus comandos con el mismo `correlation_id`; n8n los ejecuta (ramas 5a y 5b) |
| Resultado en el chat | Gradio consulta `GET /action-intents/:id/confirmation` y solo muestra «confirmada» cuando la API lo ha confirmado; después entrega el PDF |
| n8n detenido | La orden queda en cola y el paciente ve «en cola, aún sin cambios»; si n8n no la ejecuta en 120 s se descarta sin cambios |

Evidencia: 6 pruebas de integración (`confirm-via-n8n.test.ts`), pruebas de interfaz y comprobación con n8n real
(confirmacion-via-n8n.md (carpeta de evidencias)).

Aceptar o rechazar un adelanto desde Avisos también pasa por n8n (orden `offer.answer`, rama «5d»): el plazo de la
oferta se evalúa en el momento en que el paciente respondió y el planificador no la da por vencida mientras la orden está en cola.

Sin el modelo cargado: confirmación 0,1–0,3 s y PDF listo en 0,2–0,4 s. Con el modelo cargado y los otros proyectos
locales activos, la memoria de Docker se agota y n8n se bloquea hasta 25–79 s: la orden queda «en cola» y se entrega
después (ver causa-503-y-bloqueos.md (carpeta de evidencias)).

Sigue **sin** pasar por n8n:
- Las lecturas (horarios disponibles, Mis citas, avisos) y guardar el perfil: son consultas o datos del paciente, no operaciones de agenda.
- Las rutas directas `POST /action-intents/:id/confirm` y `POST /offers/:id/accept|reject` se **retiraron** (2026-10-24, revisión): ninguna operación del paciente se ejecuta fuera de la orden durable que procesa n8n.
