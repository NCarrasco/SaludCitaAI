# SaludCita AI: alcance y arquitectura

> **Actualización 23-oct-2026 (cambio de responsabilidad):** el panel administrativo deja de asignarse a Norman. Lo construye el equipo como parte funcional del sistema (entrega 3B): se sirve desde la API en `/panel/` (mismo origen), con cookie HttpOnly, CSRF y permisos por rol. Ver [panel-administrativo.md](panel-administrativo.md).

Actualizado: 23 de octubre de 2026.

La definición detallada vigente está en [especificacion-sistema.md](especificacion-sistema.md). En caso de diferencias, prevalece la especificación detallada.

## Responsabilidades

El equipo define la arquitectura e implementa API, PostgreSQL, automatizaciones n8n, Gradio e integración con calendarios. El equipo desarrolla también el panel administrativo (actualización 23-oct), que consume la misma API.

## Componentes

- Servidor VPS Contabo con Linux, elegido como alojamiento del backend.
- API REST versionada `/api/v1` con TypeScript, en un contenedor Docker.
- PostgreSQL en un contenedor con volumen persistente, accesible solo desde la red interna de los servicios.
- n8n Community en un contenedor con almacenamiento persistente y base de datos y usuario independientes de los de la aplicación. Gradio y la API se comunican con n8n mediante endpoints internos autenticados.
- Docker Compose para gestionar los servicios y un proxy inverso para HTTPS y acceso a API y n8n.
- Gradio como interfaz web principal del paciente, en un contenedor Python. Telegram queda fuera del alcance inicial.
- Calendarios externos mediante n8n. Proveedor por confirmar; Google Calendar es la propuesta inicial.
- Panel administrativo (React) servido por la API en `/panel/`, mismo origen que `/api/v1`.

API, PostgreSQL y n8n se alojarán en el mismo VPS. El panel se sirve desde el mismo contenedor de la API. Se deberán preparar reinicio automático, copias de seguridad fuera del VPS y un procedimiento de restauración. La distribución y versión de Linux, el tamaño del VPS y el dominio están pendientes de confirmar.

## Reglas de integración

PostgreSQL será la fuente de verdad de la agenda. La API valida reservas y cambios en transacciones y garantiza que un horario no tenga dos reservas activas. n8n consume operaciones de la API y sincroniza calendarios después de confirmar la operación.

Los fallos de calendario quedan registrados para reintento; no deben producir citas duplicadas. Las solicitudes repetidas de Gradio y los reintentos usarán identificadores de idempotencia.

Las ofertas de adelanto se guardan con su vencimiento en la base de datos. Un flujo programado de n8n procesa vencimientos sin mantener una petición HTTP abierta durante una hora. Se conserva la cita original hasta confirmar el adelanto. Solo habrá una oferta activa por horario y se validará nuevamente la disponibilidad al aceptar.

Fechas almacenadas con zona horaria; presentación en `America/Santo_Domingo`. Solo datos ficticios en la demostración.

## API prevista

Contrato propuesto, todavía no implementado:

- Catálogos: centros, especialidades y médicos.
- Disponibilidad: horarios por médico y rango de fechas.
- Citas: crear, consultar, cancelar y reprogramar.
- Ofertas: consultar, aceptar, rechazar y procesar vencimientos.
- Estadísticas: resumen, serie temporal, citas por médico/especialidad, ocupación de horarios y resultados de ofertas.
- Operación: salud del servicio y estado de sincronizaciones.

Las estadísticas distinguirán búsquedas, reservas, cancelaciones y asistencia; una reserva no acredita asistencia. Filtros por rango de fechas y médico/especialidad, con definiciones de cada indicador.

El panel y cualquier cliente disponen de OpenAPI, ejemplos de solicitudes y respuestas, datos ficticios de prueba e instrucciones de autenticación. Las estadísticas usarán rol viewer; las funciones administrativas requerirán operator/admin según su alcance. Las credenciales de n8n serán independientes. No se incrustarán secretos administrativos en el navegador. CORS se configurará para el dominio del panel.

## Orden de implementación

1. Modelo SQL y contrato OpenAPI.
2. API de catálogos y agenda con pruebas de concurrencia e idempotencia.
3. Estadísticas documentadas y panel administrativo.
4. Flujos n8n para el chat Gradio, cancelaciones, ofertas y vencimientos.
5. Sincronización con el proveedor de calendario elegido.
6. Despliegue y prueba integral: reserva, conflicto, cancelación, adelanto y actualización de estadísticas.

## Configuración pendiente

- VPS Contabo: distribución Linux, recursos y acceso SSH mediante clave.
- Dominio y registros DNS para API y n8n, con HTTPS.
- Credenciales separadas de PostgreSQL para la aplicación y n8n.
- Destino externo y política de copias de seguridad.
- Acceso de pacientes ficticios a Gradio y sesiones web persistentes.
- Proveedor de calendario y credenciales de integración.
- Dominio público del panel y la API (mismo origen) con HTTPS.

## Referencias de infraestructura

- https://docs.n8n.io/hosting/
