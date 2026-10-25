# Entrega 3: API para el panel de Norman

Fecha: 23 de octubre de 2026. Todo en local; sin despliegue.

## Qué funciona (verificado)

- **Sesión administrativa:** cookie HttpOnly `sc_admin` y protección CSRF por doble envío (cabecera `X-CSRF-Token`). Login con límite de intentos, logout que revoca la sesión y `/auth/me`. Las sesiones de paciente y las administrativas no son intercambiables.
- **Roles `viewer`, `operator` y `admin`**, cada uno con su usuario ficticio en el seed.
- **CORS** con lista blanca y credenciales. Se probó con un origen autorizado y con uno no autorizado.
- **Estadísticas:**
  - `/stats/summary`, `/timeseries`, `/doctors`, `/specialties`, `/occupancy`, `/offers` y `/conversation`;
  - filtros de periodo local, centro, médico y especialidad;
  - numeradores, denominadores, definiciones y hora de corte en cada respuesta;
  - sin nombres de pacientes.
- **Conciliación:**
  - la prueba automatizada compara la API con las operaciones realizadas y con SQL independiente;
  - la SQL publicada en [docs/estadisticas.md](../estadisticas.md) coincide con la API sobre la base de desarrollo (1056/4 slots, 9/5/4 operaciones, recuperación 2/3).
- **Operación:**
  - traspasos (listar y resolver);
  - registro de asistencia (tras el inicio, con versión e idempotencia);
  - cola (listar y reintentar solo trabajos `dead`);
  - estado de integraciones sin secretos: el calendario figura como `pending_credentials` y el modelo se comprueba en el momento.
- **Artefactos para Norman:**
  - [OpenAPI](../../contracts/openapi.yaml), validado con Redocly;
  - [17 ejemplos JSON reales](../../contracts/examples/);
  - [colección Postman](../../contracts/saludcita-panel.postman_collection.json), validada con Newman: 12/12 aserciones;
  - [guía de integración](../panel-norman.md).

## Comandos ejecutados y resultados

```text
./scripts/bootstrap-env.sh                → 3 claves nuevas (SEED_ADMIN_PASSWORD, ADMIN_SESSION_TTL_HOURS, COOKIE_SECURE)
docker compose … up -d --build api        → migración 0004 aplicada, usuarios administrativos creados
cd apps/api && npm test                   → 8 archivos, 76 pruebas superadas
npm run openapi:lint                      → válido
node scripts/generate-examples.mjs        → 17 ejemplos
npx newman@6.2.1 run contracts/…          → 12 peticiones, 12 aserciones, 0 fallos
node scripts/smoke-test.mjs               → 15/15 comprobaciones
```

Evidencias en docs/evidencias/entrega-3/ (carpeta de evidencias).

## Limitaciones y pendientes

- Ofertas, adelantos y recuperación por ofertas valen 0 hasta la entrega 4. La recuperación ya refleja reocupaciones tras cancelaciones o reprogramaciones.
- No hay endpoints de mantenimiento (CRUD de catálogos y agenda) ni listado administrativo de citas.
- La configuración de cookies y CORS para el dominio real del panel depende del despliegue.
- **No se construyó el panel** en esta entrega: el encargo vigente entonces lo asignaba a Norman. *Actualización:* el panel se construyó después en la entrega 3B.
- Siguen pendientes, de la entrega 2, la mejora conversacional ante intención incierta y la medición en Contabo.

## Próxima entrega

Entrega 4: automatizaciones. Ofertas secuenciales de adelanto con cascada y vencimiento, recordatorios en la bandeja, consumo de la cola durable con leases y reintentos, y Google Calendar (pendiente de credenciales).
