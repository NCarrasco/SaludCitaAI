# Entrega 1: base y agenda

Fecha: 23 de octubre de 2026. Entorno: local (macOS, Docker 29.5, Node 24). No se conectó ni desplegó nada en Contabo.

## Qué funciona (verificado)

- Docker Compose local: PostgreSQL 18.6 (roles y bases separados para la aplicación, n8n y pruebas), un servicio `migrate` de una sola ejecución y la API con healthcheck. Puertos solo en `127.0.0.1`.
- 2 migraciones SQL versionadas y reversibles (las pruebas verifican up → down → up). Esquema completo de la especificación con las precisiones de referencias-y-viabilidad.md: 29 tablas, FK `RESTRICT`, estados con `CHECK`, índices parciales y exclusiones GiST.
- Seed idempotente: 1 centro, 3 especialidades, 6 médicos, 20 pacientes y cuentas, 1056 slots para 30 días y una ausencia de ejemplo que bloquea un día laborable.
- Autenticación de pacientes con scrypt, token opaco hasheado, expiración, logout que revoca la sesión y límite de intentos por IP y usuario.
- API: salud, catálogos, disponibilidad (por servicio, médico o especialidad, con paginación por cursor y búsquedas registradas sin duplicar), perfil, citas propias, intenciones (reserva, cancelación, reprogramación) y confirmación transaccional idempotente.
- En la misma transacción que cada cita: evento inmutable, evento analítico, aviso en bandeja, `calendar_sync` con su trabajo de sincronización y recordatorios a 24 h y 1 h. Estos trabajos se consumen en la entrega 4.
- Contrato OpenAPI 3.1 generado desde los esquemas de las rutas; Redocly lo valida sin errores ni avisos y una prueba comprueba que coincide con el código.

## Criterios de aceptación cubiertos en esta entrega

| Criterio | Prueba | Resultado |
|---|---|---|
| 20 solicitudes concurrentes del mismo horario → exactamente una cita activa | `booking.test.ts` (20 pacientes y 20 confirmaciones en paralelo) | ✔ 1 × 200, 19 × 409. Se comprobó que la prueba falla si se quita el bloqueo `FOR UPDATE` |
| Reintento con la misma clave → mismo resultado | `booking.test.ts` y prueba de humo | ✔ |
| Un paciente no consulta ni modifica citas ajenas | `booking.test.ts` y prueba de humo | ✔ 404 en lectura, preparación y confirmación con token ajeno |
| Confirmación vencida o antigua no modifica una cita | `booking.test.ts` (410 caducada, 409 reemplazada, 409 versión) | ✔ |
| Reprogramación fallida conserva la reserva original | `booking.test.ts` | ✔ mismo slot y versión 1 |
| Reiniciar contenedores conserva datos | `compose down` y `up` manual | ✔ mismas citas, eventos y slots. La recuperación de trabajos se prueba en la entrega 4 |

Evidencias reales en docs/evidencias/entrega-1/ (carpeta de evidencias): salida de las 32 pruebas, prueba de humo, lint de OpenAPI y entorno.

## Comandos ejecutados y resultados

```text
./scripts/bootstrap-env.sh                                        → .env creado
docker compose --env-file .env -f infra/compose.yaml up -d --build → postgres healthy, migrate exited 0, api healthy
cd apps/api && npm test                                           → 3 archivos, 32 pruebas superadas (~4 s)
npm run typecheck                                                 → sin errores
npm run openapi:lint                                              → "Your API description is valid"
node scripts/smoke-test.mjs                                       → 10/10 comprobaciones
```

## Limitaciones y dependencias pendientes

- Cancelar o reprogramar todavía **no** inicia rondas de ofertas de adelanto: entrega 4.
- Los trabajos de `outbox_jobs` (calendario y recordatorios) se crean pero nada los consume aún: entrega 4. No se afirma ninguna sincronización con Google Calendar.
- No hay credenciales de servicio para n8n ni endpoints `/internal/*`: entrega 2.
- Autenticación administrativa y estadísticas: entrega 3.
- La agenda se regenera con el seed o con `npm run db generate-slots`. La tarea diaria automática llega con n8n.

## Próxima entrega

Entrega 2: interfaz Gradio con identidad SaludCita AI, n8n Community en Compose, endpoints internos con credenciales de servicio, conversación persistente con leases y evaluación medida de un modelo local en Ollama (licencia, español, salida estructurada, memoria y latencia con los 4 CPU / 8 GiB de referencia). Si no supera la batería de pruebas, se usará extracción estructurada con una máquina de estados determinista.
