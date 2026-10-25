# Panel administrativo

Interfaz web del personal del hospital simulado. Forma parte del mismo sistema que el chat de pacientes (Gradio), pero es una aplicación independiente:

- **Pacientes (chat Gradio):** http://127.0.0.1:7860
- **Personal (panel):** http://127.0.0.1:8080/panel/

El panel solo consume la API. No accede a PostgreSQL ni contiene secretos.

> **Cambio de responsabilidad (23-oct-2026):** el panel, que antes se asignaba a Norman, lo construye el equipo como parte funcional del proyecto (entrega 3B).

## Acceso local

1. Levanta el sistema según el [README](../README.md).
2. Abre http://127.0.0.1:8080/panel/. La raíz `http://127.0.0.1:8080/` redirige ahí.
3. Inicia sesión con una cuenta de demostración. La contraseña es `SEED_ADMIN_PASSWORD` de tu `.env` (en la demostración local, `12345678`).

| Cuenta | Rol | Qué puede hacer |
|---|---|---|
| `panel@saludcita.test` | `viewer` | Inicio (cifras agregadas, sin pacientes) y Estadísticas |
| `operador@saludcita.test` | `operator` | Lo anterior; además Citas (buscar, ver detalle e historial, registrar asistencia) y Solicitudes de ayuda |
| `admin@saludcita.test` | `admin` | Todo; además Configuración (profesionales, agenda, centro) y Sistema (integraciones, trabajos y reintentos, diagnóstico del asistente) |

Los permisos se aplican **en el servidor**: cada endpoint exige su rol mínimo. La interfaz solo oculta lo que el rol no puede usar; si alguien fuerza una URL, el panel avisa de que no tiene acceso y la API responde 403.

### Matriz de roles por endpoint (revisada al reorganizar el panel, 24-oct-2026)

| Endpoint | viewer | operator | admin | Cambio |
|---|:-:|:-:|:-:|---|
| `GET /admin/dashboard`, `GET /admin/events` (SSE) | ✓ (agregado) | ✓ | ✓ | — |
| `GET /stats/summary`, `/timeseries`, `/occupancy`, `/specialties`, `/doctors`, `/offers` | ✓ | ✓ | ✓ | — |
| `GET /admin/catalog`, `GET /admin/service-info` | ✓ | ✓ | ✓ | — |
| `GET /admin/appointments`, `POST /appointments/{id}/attendance` | — | ✓ | ✓ | — |
| `GET /admin/appointments/{id}` (detalle e historial, solo lectura) | — | ✓ | ✓ | **Nuevo** |
| `GET /handoffs`, `PATCH /handoffs/{id}` | — | ✓ | ✓ | — |
| Escrituras de configuración (`/admin/centers`, `/specialties`, `/doctors`, `/doctor-services`, `/schedule-*`), `GET /admin/doctor-services/{id}/schedule` | — | — | ✓ | — |
| `GET/PUT /admin/calendar-bindings` | — | — | ✓ | — |
| `GET /admin/integrations` | ~~✓~~ | ~~✓~~ | ✓ | **Restringido** (antes viewer): diagnóstico técnico |
| `GET /admin/jobs`, `POST /admin/jobs/{id}/retry` | — | ~~✓~~ | ✓ | **Restringido** (antes operator): reintentos solo con autorización técnica |
| `GET /stats/conversation` | ~~✓~~ | ~~✓~~ | ✓ | **Restringido** (antes viewer): uso del modelo, latencia y tokens son métricas técnicas, no de servicio |

Ninguna restricción afecta a n8n ni a la pasarela de Gradio: usan credenciales de servicio en rutas `/internal/*` y `/gateway/*`, no la sesión del panel.

## Secciones

Navegación por tareas del personal: cinco secciones principales y una técnica aparte. Las secciones con subsecciones
usan pestañas con ruta propia (`#/estadisticas/ocupacion`, `#/configuracion/centro`, `#/sistema/trabajos`), para que
los enlaces profundos funcionen y el menú lateral no crezca.

| Sección | Rol mínimo | Contenido | Endpoints | Actualización |
|---|---|---|---|---|
| Inicio | viewer | Indicadores del día (citas con pendientes, sin marcar y asistencias; próxima cita; horarios libres; operaciones registradas), agenda del día con marca «ahora», **Pendientes** (una fila por tipo con su cantidad real: citas sin asistencia, solicitudes abiertas, confirmaciones atascadas, trabajos fallidos, comprobantes), Movimientos (actividad reciente y próximas citas, paginados), tendencia de 14 días y disponibilidad bajo demanda | `/admin/dashboard`, `/stats/timeseries` | En vivo + recálculo cada minuto de lo que cambia solo con el reloj |
| Citas | operator | Listado con periodo, estado, especialidad, médico y búsqueda; **detalle con historial** (`#/citas?cita=<id>`); registro de asistencia (única acción con API para el personal) | `/admin/appointments`, `/admin/appointments/{id}`, `/appointments/{id}/attendance` | En vivo |
| Solicitudes de ayuda | operator | Abiertas y resueltas; antigüedad, motivo, marcar como resuelta | `/handoffs` | En vivo |
| Estadísticas › Actividad | viewer | Indicadores del periodo; asistencia con **cobertura de registro** («registro incompleto» si hay citas sin marcar); evolución diaria | `/stats/summary`, `/stats/timeseries` | En vivo |
| Estadísticas › Ocupación | viewer | Mapa de calor; ocupados/libres por especialidad y médico | `/stats/occupancy`, `/stats/specialties`, `/stats/doctors` | En vivo |
| Estadísticas › Adelantos | viewer | Ofertas de adelanto, aceptación, adelanto conseguido y recuperación de horarios | `/stats/offers` | En vivo |
| Configuración › Profesionales | admin | Médicos, especialidades y servicios (con precio) | `/admin/catalog`, `/admin/...` | Catálogo en vivo |
| Configuración › Agenda | admin | Reglas de horario y ausencias con impacto previo | `/admin/doctor-services/{id}/schedule`, `/admin/schedule-*` | — |
| Configuración › Centro | admin | Ficha del centro (ubicación, contacto, instrucciones, seguros, pagos). Con un solo centro se muestra la ficha directamente; la gestión de varios centros sigue disponible en «Gestionar centros» | `/admin/centers` | Catálogo en vivo |
| Configuración › Vista previa al paciente | admin | Herramienta secundaria: lo que respondería el asistente con los datos actuales | `/admin/service-info` | — |
| Sistema › Integraciones | admin | Base de datos, modelo local, Google Calendar (vínculos por médico), cola y mensajes del chat | `/admin/integrations`, `/admin/calendar-bindings` | Periódica (30 s) |
| Sistema › Trabajos y reintentos | admin | Trabajos por estado; reintento manual solo de los que agotaron reintentos | `/admin/jobs` | Periódica (30 s) |
| Sistema › Diagnóstico del asistente | admin | Uso del asistente por modo, fallos del modelo, latencia, tokens (uso de IA ≠ éxito); evaluaciones históricas del modelo como evidencia académica | `/stats/conversation` | Periódica (60 s) |

**Rutas anteriores** (siguen funcionando, redirigen): `#/resumen` → `#/estadisticas/actividad`, `#/ocupacion` →
`#/estadisticas/ocupacion`, `#/ofertas` → `#/estadisticas/adelantos`, `#/traspasos` → `#/ayuda`, `#/mantenimiento` →
`#/configuracion/profesionales`.

### Actualización en vivo

- PostgreSQL emite `NOTIFY` al confirmar cada cambio (migración `0014`: citas, solicitudes de ayuda, ofertas y auditoría
  de mantenimiento). **Una** conexión `LISTEN` por proceso de la API reenvía el aviso por **SSE** (`GET /admin/events`,
  sesión del panel, máx. 4 flujos por sesión, latido cada 20 s que comprueba la sesión).
- El aviso no lleva datos personales: `topic`, `kind` y `at`; operator/admin reciben además el `id` de la cita para
  revalidar lo que estén editando. Cada pantalla vuelve a pedir sus datos a los endpoints autorizados, con sus filtros y
  paginación. Avisos cercanos se agrupan (400 ms).
- Al reconectar, al recuperar la red o al volver a la pestaña se reconcilia todo. Si la conexión `LISTEN` se cae, la API
  envía `degraded` y, al recuperarla, `resync`. Cerrar sesión termina el flujo (`session-ended`).
- Indicador en la cabecera: «En vivo», «Reconectando…» o «Sin conexión en vivo», con la hora del último cambio recibido.
  Cada tarjeta muestra la hora real de sus datos. Los formularios abiertos no se borran: los datos se actualizan por
  debajo.
- Al cambiar filtros no se muestran resultados de la consulta anterior: la petición previa se cancela y se ignora.

Cada sección muestra estados de carga, vacío, error (con la referencia de la petición), datos desactualizados si falla una actualización y la hora de los datos («Datos de las HH:MM:SS», botón «Actualizar»).

### Datos institucionales e «Información al paciente» (24-oct-2026)

- **Centros → Ficha** (admin): dirección, teléfono, correo, notas para pacientes, seguros aceptados y formas de pago
  (`PATCH /admin/centers/{id}`). Las listas se guardan sin vacíos ni repetidos; un campo vacío queda «no registrado».
- **Servicios**: columna y campo **Precio (RD$)** (`price_dop` en `POST`/`PATCH /admin/doctor-services`). Cambiar solo el
  precio o las instrucciones no reconcilia la agenda.
- **Información al paciente** (viewer o superior): vista previa de lo que responde el asistente por tema, especialidad e
  idioma (`GET /admin/service-info`). Usa la misma función que la rama «información del servicio» del chat; no usa el modelo.
- Pruebas: `maintenance.test.ts` (catálogo, edición, validación, permisos y vista previa) y `panel-informacion.spec.ts`
  (escritorio y móvil: editar la ficha y ver el cambio en la vista previa).

### Pendiente en el panel (sin soporte en la API todavía)

| Función | Estado |
|---|---|
| Detalle de una cita con su historial de eventos; cancelar o reprogramar por el personal | Sin API |
| Ofertas de adelanto y avisos individuales (solo hay estadísticas agregadas) | Sin API |
| Órdenes de n8n (`appointment.confirm`, `offer.answer`) y estado de n8n | Solo conteos indirectos |
| Asignar, anotar o ver la conversación de una solicitud de ayuda | Solo listar y resolver |
| Usuarios administrativos, roles y registro de auditoría | Sin API (usuarios del seed) |

## Reglas de mantenimiento

- **No se borra historial.** Centros, especialidades, médicos y servicios se **desactivan**: dejan de admitir reservas nuevas y conservan las citas existentes. Las reglas se **finalizan** con `valid_until`. Solo se pueden retirar ausencias que todavía no han empezado.
- **Simulación previa obligatoria en la interfaz.** Cada cambio de agenda se envía primero con `dry_run=true`. Esa simulación se ejecuta en una transacción que se revierte, y el panel muestra el impacto antes de confirmar:
  - slots libres que se bloquean;
  - slots que se reabren;
  - slots nuevos;
  - **citas reservadas en conflicto**.
- **Las citas nunca se cancelan ni se mueven solas.** Si una ausencia o un cambio de horario afecta a una cita reservada, la cita se conserva y aparece como conflicto (referencia, fecha, paciente y motivo) para que el personal la gestione.
- **Auditoría.** Cada cambio confirmado queda en `admin_audit_log`, una tabla de solo inserción, con quién lo hizo, el estado anterior y posterior, y el impacto.

## Seguridad

- **Mismo origen:** la API sirve el panel en `/panel/`, así que no necesita CORS.
- **Sesión:**
  - cookie `sc_admin` HttpOnly (`SameSite=Lax`, `Secure` con `COOKIE_SECURE=true` en HTTPS);
  - sesiones revocables al cerrar sesión, con caducidad de 8 h;
  - las escrituras envían `X-CSRF-Token`, que el panel lee de la cookie `sc_csrf`.
- **Cabeceras del panel:**
  - CSP `default-src 'self'` sin scripts ni estilos externos, `frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`;
  - las respuestas de la API llevan `Cache-Control: no-store`.
- **Datos:** el panel no contiene tokens de servicio, contraseñas ni accesos a PostgreSQL. Los nombres de pacientes (ficticios) solo aparecen en las secciones de rol `operator` o superior. Las estadísticas no los incluyen.

## Tecnología y licencias

| Componente | Versión | Licencia |
|---|---|---|
| React / React DOM | 19.3.1 | MIT |
| Chart.js | 4.6.1 | MIT |
| Vite + @vitejs/plugin-react (solo compilación) | 8.3.5 / 6.1.2 | MIT. Algunas dependencias de compilación de Vite usan MPL-2.0 y Apache-2.0; no se distribuyen en el panel |
| TypeScript (solo compilación) | 7.0.2 | Apache-2.0 |
| @fastify/static (API) | 10.1.7 | MIT |

- Código fuente: [apps/admin-panel/](../apps/admin-panel/).
- Dependencias fijadas en `package-lock.json`.
- La imagen Docker de la API compila el panel en una etapa previa.
- **Sin fuentes, CDNs ni servicios externos.**

Desarrollo con recarga en caliente, desde `apps/admin-panel`, con la API en el puerto 8080 (Vite reenvía `/api` y se abre en http://localhost:5173/panel/):

```bash
npm ci && npm run dev
```

## API para otros clientes

- [contracts/openapi.yaml](../contracts/openapi.yaml): contrato OpenAPI 3.1.
- [contracts/examples/](../contracts/examples/): ejemplos JSON reales.
- [contracts/saludcita-panel.postman_collection.json](../contracts/saludcita-panel.postman_collection.json): colección validada con Newman.
- [docs/estadisticas.md](estadisticas.md): definiciones y SQL de conciliación.

Un cliente en otro origen necesita estar en `CORS_ALLOWED_ORIGINS` y revisar la política de cookies.

## Diseño

Se inspiró en el prototipo HTML inicial del equipo (conservado sin cambios, fuera del repositorio público):

- se tomaron la barra lateral, las tarjetas de métricas, la paleta neutra y la tipografía del sistema;
- se aplicó el verde azulado de la identidad SaludCita AI que usa el chat Gradio;
- no se reutilizó su código, porque el prototipo funciona con datos y reloj simulados en memoria y el panel debe mostrar solo datos reales de la API.

El panel soporta modo claro y oscuro (`prefers-color-scheme`) y se adapta a móvil: menú plegable, tablas con desplazamiento propio y sin desbordamiento horizontal de la página. Esto último se verificó en 375 px.
