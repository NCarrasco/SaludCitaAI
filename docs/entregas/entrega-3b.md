# Entrega 3B: panel administrativo

Fecha: 23 de octubre de 2026. Todo en local; sin conexión a Contabo.

## Cambio de responsabilidad

El panel, antes asignado a Norman, lo construye el equipo como parte funcional del sistema. Se actualizaron [especificacion-sistema.md](../especificacion-sistema.md) y [arquitectura.md](../arquitectura.md), y la guía pasó a [panel-administrativo.md](../panel-administrativo.md).

## Decisión sobre el prototipo

El prototipo HTML inicial del equipo (un HTML de 23 KB sin dependencias ni licencia de terceros, con datos y reloj simulados) se conserva intacto fuera del repositorio público. El panel se construyó **desde cero**:

- toma del prototipo solo el lenguaje visual (barra lateral, tarjetas, paleta neutra);
- aplica la identidad verde azulada SaludCita AI;
- no reutiliza su código, porque está basado en simulación.

## Qué funciona (verificado)

URL local: http://127.0.0.1:8080/panel/ (servido por la API, mismo origen).

- **Sesión:** inicio y cierre con los tres roles; cookie HttpOnly, CSRF y sesión revocable.
- **Resumen:** filtros de periodo, centro, especialidad y médico; indicadores con numeradores, denominadores y definiciones; gráficos de actividad, ocupación y resultados.
- **Ocupación:** mapa de calor por día y hora, y tablas por especialidad y médico.
- **Ofertas y asistente:** ofertas marcadas **pendientes (entrega 4)** con ceros explicados; recuperación real; calidad del asistente (modos, aclaraciones, fallos del modelo, latencia, tokens).
- **Citas (operator):** búsqueda con filtros y paginación; registro de asistencia solo en citas ya iniciadas, con confirmación e idempotencia.
- **Solicitudes de ayuda (operator):** listado y resolución.
- **Integraciones y cola:**
  - base de datos y modelo comprobados en el momento;
  - Google Calendar marcado **pendiente de credenciales**;
  - cola con reintento solo de trabajos `dead` (operator).
- **Mantenimiento (admin):**
  - centros, especialidades y médicos: crear, renombrar, desactivar y reactivar;
  - servicios: crear y editar;
  - reglas semanales: añadir y finalizar;
  - ausencias: registrar y retirar las futuras.
  - Todos los cambios de agenda muestran antes una **simulación del impacto**. Las citas afectadas se listan como conflictos y **no se cancelan ni se mueven**.
- **Endpoints nuevos:**
  - `GET /admin/catalog`, `GET /admin/appointments`;
  - `POST/PATCH /admin/{centers,specialties,doctors,doctor-services}`;
  - `GET /admin/doctor-services/{id}/schedule`;
  - `POST/PATCH /admin/schedule-rules`;
  - `POST/DELETE /admin/schedule-exceptions` (con `dry_run`).
  - Todo con auditoría en `admin_audit_log`.

## Pruebas ejecutadas

```text
cd apps/api && npm test                       → 9 archivos, 86 pruebas (10 nuevas: permisos, dry_run, conflictos sin cancelar,
                                                 reapertura al retirar ausencia, desactivación, auditoría, búsqueda, servido de /panel/)
npm run openapi:lint                          → válido
cd apps/admin-panel && npm run build          → tipos correctos, 149 KB gzip
npx newman@6.2.1 run … (rol admin)            → 16 peticiones, 16 aserciones, 0 fallos
node scripts/smoke-test.mjs                   → 16/16 (incluye /panel/ con CSP)
Revisión visual escritorio y móvil            → ver evidencias/entrega-3b/revision-visual.md (3 defectos corregidos)
```

## Limitaciones

- No hay pruebas automatizadas de la interfaz (de extremo a extremo en el navegador). La interfaz se verificó manualmente y su lógica se apoya en la API, que sí está probada.
- No se pueden editar los días y horas de una regla existente desde la interfaz: se finaliza y se crea otra. La API sí admite `PATCH` completo.
- Los conflictos de agenda se muestran, pero el panel todavía no ofrece una acción para reprogramar la cita en nombre del paciente: el personal debe contactarlo.
- No hay alta ni edición de usuarios administrativos desde el panel (solo los del seed).
- Las ofertas, los recordatorios y el calendario dependen de la entrega 4.

## Próxima entrega

Entrega 4: ofertas secuenciales en cascada, vencimientos, recordatorios en la bandeja, consumo de la cola durable con leases y reintentos, y Google Calendar (pendiente de credenciales).
