# Entrega 2: Gradio, conversación y n8n

Fecha: 23 de octubre de 2026. Todo en local; no hubo conexión con Contabo ni despliegue.

## Qué funciona (verificado)

- **Gradio** ([apps/demo-gradio](../../apps/demo-gradio)):
  - Inicio de sesión con cuentas ficticias.
  - Chat con identidad SaludCita AI y botones de horarios, fechas, especialidades y citas.
  - Panel de confirmación con **Confirmar** y **Descartar**, y casilla de aceptación de ofertas de adelanto.
  - Pestañas «Mis citas» y «Avisos» (bandeja persistente, marcar como leído y actualización cada 30 s).
  - Estados de carga («Procesando… N s»), error y recuperación.
  - El token del paciente vive solo en `gr.State` (servidor).
  - Revisado en el navegador en escritorio y en móvil (375 px).
- **Identidad verificada por la API.**
  - Gradio llama a la API con la sesión del paciente.
  - La API fija `patient_id` al recibir cada mensaje.
  - n8n usa una credencial de servicio con scope `bot` y nunca elige la identidad.
  - Los endpoints internos rechazan tokens de paciente (403) y peticiones sin token (401).
- **Confirmación fuera del modelo.** El modelo no recibe IDs, tokens ni operaciones. La propuesta no lleva tokens. Al pulsar **Confirmar**, el backend de Gradio prepara la intención y la confirma con idempotencia. Un «sí» escrito no confirma.
- **n8n Community 2.44.6.** Las credenciales se generan desde `.env` y los workflows se importan y publican por CLI en una instancia nueva (evidencia (carpeta de evidencias)). El workflow de conversación usa:
  - un webhook autenticado (403 sin secreto);
  - reclamación con lease;
  - la llamada a Ollama con rama de error;
  - la entrega del resultado o del error;
  - recuperación cada minuto.
- **Recuperación probada de verdad.** Con Ollama apagado, el workflow registró `getaddrinfo EAI_AGAIN ollama` y el paciente recibió el menú, marcado como recuperación.
- **Memoria persistente.** Estado estructurado y mensajes en PostgreSQL. El historial se restaura al iniciar sesión. Los turnos se serializan por conversación. Un mensaje duplicado no se duplica y los leases vencidos se recuperan.
- **Fechas** completas en `America/Santo_Domingo`, resueltas de forma determinista. Las expresiones ambiguas («el martes» dicho un martes, «el próximo miércoles» dicho un martes) generan una pregunta con opciones.
- **Evaluación de Ollama** con todos los servicios activos: ver [docs/evaluacion-ia-local.md](../evaluacion-ia-local.md).

## Resultados de la IA (resumen honesto)

- Solo se pudo evaluar **`qwen3:1.7b`** (Apache 2.0): ~1,7 GiB, p50 de 1,1 s por interpretación en esta máquina.
- `qwen3:4b`, `llama3.2:3b` y `granite4:3b` murieron por falta de memoria al cargarse: la VM de Docker tenía ~2 GiB libres porque la compartían contenedores de otros proyectos. **No hay medición de su calidad.**
- Extremo a extremo por la ruta real:
  - batería de control: **10/15** correctos;
  - batería principal tras los ajustes: 34/38, cifra **sesgada** porque se ajustó contra ella;
  - **0 citas creadas sin el botón** en todas las ejecuciones.
- Punto débil: la **clasificación de intención** (por ejemplo, confunde «quiero turno con cardiología» con un saludo). Los fallos son seguros, pero obligan a reformular.
- **No se declara viable en Contabo.** Las latencias se midieron en Apple Silicon, no en una vCPU del VPS.

## Comandos ejecutados y resultados

```text
./scripts/bootstrap-env.sh                                              → 11 claves nuevas añadidas a .env
docker compose --env-file .env -f infra/compose.yaml --profile ai up -d --build
                                                                        → postgres, migrate, api, n8n-import, n8n, ollama, gradio
docker compose … exec ollama ollama pull qwen3:1.7b (y los otros 3 candidatos)
cd apps/api && npm test                                                 → 7 archivos, 65 pruebas superadas
npm run openapi:lint                                                    → válido
npx tsx eval/interpretation.ts qwen3:1.7b llama3.2:3b granite4:3b qwen3:4b
npx tsx eval/e2e.ts ; npx tsx eval/e2e.ts --battery holdout.json
node scripts/smoke-test.mjs                                             → 12/12, conversación en modo «ai»
```

## Limitaciones y dependencias pendientes

- **Decisión del equipo:** repetir la evaluación de los modelos de 3–4 B sin los contenedores ajenos o en el VPS, y aceptar o no la tasa actual de intención.
- No se evaluó un AI Agent de n8n con herramientas (decisión D1).
- Las ofertas de adelanto, los recordatorios en bandeja (consumo de `outbox_jobs`) y Google Calendar quedan para la entrega 4. La casilla de ofertas guarda `advance_opt_in`, pero todavía no se generan ofertas.
- El paciente debe volver a iniciar sesión si recarga la página (`gr.State` no persiste). La conversación sí se restaura.
- Las baterías son pequeñas y sintéticas; los subgrupos tienen n bajo.

## Decisiones posteriores del equipo

- `qwen3:1.7b` queda como modelo **provisional**.
- La batería de control se mantiene congelada.
- La mejora de aclaraciones ante intención incierta y la medición en Contabo quedan pendientes antes de cerrar el MVP (ver [evaluación §5](../evaluacion-ia-local.md)).

## Próxima entrega

Entrega 3: API para el panel de Norman. Incluye estadísticas con numeradores, denominadores y definiciones, autenticación y roles administrativos con cookie, CORS, ejemplos JSON y colección de peticiones.
