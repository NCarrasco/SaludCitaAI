# Definiciones de estadísticas

Cada indicador de `/api/v1/stats/*` se calcula **solo** con datos persistidos en PostgreSQL. Ninguno se infiere de mensajes ni de ejecuciones de n8n. Este documento da la definición exacta y una consulta SQL independiente para conciliar el resultado. Las mismas definiciones, resumidas, vienen en el campo `definitions` de cada respuesta. Implementación: [apps/api/src/modules/stats/queries.ts](../apps/api/src/modules/stats/queries.ts). Prueba de conciliación: [admin-stats.test.ts](../apps/api/test/integration/admin-stats.test.ts).

## Convenciones

- **Periodo:** `from` y `to` son **fechas locales** (`AAAA-MM-DD`) en `America/Santo_Domingo`. El intervalo es `[from, to)`: `to` se excluye. El máximo son 366 días. En SQL: `t0 = (from::date)::timestamp AT TIME ZONE 'America/Santo_Domingo'` y lo mismo para `t1`.
- **Filtros:** `center_id`, `doctor_id` y `specialty_id` restringen el **servicio** (`doctor_services`) del slot asociado a cada dato.
- **Proporciones:** se devuelven como `rate` (0–1, 4 decimales) **junto con su numerador y denominador**. Si el denominador es 0, `rate` es `null`.
- **Envoltorio de la respuesta:** `{ filters, timezone, generated_at, definitions, data }`. `generated_at` es la hora de corte.
- **Privacidad:** las estadísticas no incluyen nombres de pacientes, chats ni mensajes. Solo aparecen nombres de médicos y especialidades (ficticios).
- **Dos cohortes que no deben mezclarse:**
  - *Operaciones*: se cuentan por la **fecha en que ocurrieron** (`appointment_events.occurred_at`).
  - *Agenda, ocupación y asistencia*: se cuentan por la **fecha de inicio del slot** de la cita.

## Indicadores

| Indicador | Endpoint y campo | Definición |
|---|---|---|
| Búsquedas | `summary.searches`, `timeseries.searches` | Eventos `analytics_events.event_type = 'availability_search'` en el periodo. Una misma búsqueda del mismo paciente con los mismos filtros en una ventana de 5 min cuenta una vez (`dedupe_key`). Incluye búsquedas que no terminan en reserva. Con filtros, cuentan las búsquedas hechas sobre un servicio que cumple **todos** los filtros. Una búsqueda solo por especialidad (sin servicio concreto) cuenta únicamente cuando el filtro es solo de especialidad; con filtro de centro o médico se **excluye**, porque no se puede atribuir (corregido el 24-oct-2026: antes se contaba aunque hubiera filtro de médico o centro) |
| Reservas, cancelaciones, reprogramaciones, adelantos | `summary.operations`, `timeseries`, `doctors`, `specialties` | Eventos `appointment_events` (`booked`, `cancelled`, `rescheduled`, `advanced`) con `occurred_at` en el periodo. El filtro usa el slot **destino** (reserva, cambio, adelanto) o el **origen** (cancelación) |
| Agenda por estado | `summary.agenda_by_status` | Citas cuyo slot **actual** empieza en el periodo, agrupadas por su estado actual |
| Ocupación | `summary.occupancy`, `timeseries`, `doctors`, `specialties`, `occupancy` | `occupied / enabled`. **enabled** = slots con `status = 'open'` que empiezan en el periodo. **occupied** = de ellos, los que tienen una cita `booked`, `completed` o `no_show`. `held_by_offer` (retenidos por una ronda de ofertas abierta y sin cita) y `blocked` se informan aparte y **no** cuentan como ocupados |
| Asistencia | `summary.attendance`, `doctors`, `specialties` | Sobre citas ya iniciadas del periodo. `completed` y `no_show` los marca el personal (`POST /appointments/{id}/attendance`). `unmarked` = siguen en `booked`. `rate = completed / (completed + no_show)`. **Una reserva no acredita asistencia** |
| Ofertas | `offers.offers_by_status` | `advance_offers` por `offered_at` en el periodo y estado (`pending`, `accepted`, `rejected`, `expired`, `invalidated`, `delivery_failed`). `acceptance_rate = accepted / (accepted + rejected + expired)` |
| Recuperación | `offers.recovery` | **freed_eligible_slots** = slots **distintos** liberados por cancelación, reprogramación o adelanto **antes de su inicio** en el periodo. **recovered_slots** = de ellos, los que volvieron a ocuparse (reserva, cambio o adelanto hacia ese slot) después de liberarse y **antes de su inicio**. Se mide hasta `generated_at`: un slot futuro aún puede recuperarse |
| Adelanto conseguido | `offers.advance_minutes` | Por cada evento `advanced` del periodo: `from_starts_at − to_starts_at` en minutos. Media, mediana y `n` |
| Calidad del asistente | `conversation` | Mensajes `messages.direction = 'outbound'` del periodo por `mode` (`ai`, `deterministic`, `fallback_menu`, `system`). `clarifications` = respuestas que piden un dato con opciones (fecha, especialidad o cita). `llm_errors` = respuestas por fallo del modelo. `model_latency_ms` sale de `messages.latency_ms`. También tokens y `handoffs` creados. **No admite filtros de médico o especialidad** |

> Las ofertas, los adelantos y la recuperación por ofertas llegan con la entrega 4. Hasta entonces esos contadores valen 0 o reflejan solo cancelaciones y reprogramaciones.

## SQL de conciliación

Sustituye `:from` y `:to` por fechas locales. Puedes ejecutarlas con `psql` contra la base `saludcita`.

```sql
-- Límites del periodo
WITH b AS (SELECT (:'from'::date)::timestamp AT TIME ZONE 'America/Santo_Domingo' AS t0,
                  (:'to'::date)::timestamp AT TIME ZONE 'America/Santo_Domingo' AS t1)

-- Operaciones (summary.operations)
SELECT e.event_type, count(*) FROM appointment_events e, b
WHERE e.occurred_at >= b.t0 AND e.occurred_at < b.t1 GROUP BY 1;
```

```sql
-- Ocupación (summary.occupancy): enabled y occupied
WITH b AS (...)
SELECT count(*) FILTER (WHERE s.status = 'open') AS enabled,
       count(DISTINCT a.slot_id) FILTER (WHERE s.status = 'open') AS occupied
FROM slots s LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ('booked','completed','no_show'), b
WHERE s.starts_at >= b.t0 AND s.starts_at < b.t1;
```

```sql
-- Búsquedas (summary.searches)
WITH b AS (...)
SELECT count(*) FROM analytics_events a, b
WHERE a.event_type = 'availability_search' AND a.occurred_at >= b.t0 AND a.occurred_at < b.t1;
```

```sql
-- Asistencia (summary.attendance)
WITH b AS (...)
SELECT a.status, count(*) FROM appointments a, b
WHERE a.starts_at >= b.t0 AND a.starts_at < b.t1 AND a.starts_at <= now() GROUP BY 1;
```

```sql
-- Recuperación (offers.recovery)
WITH b AS (...),
freed AS (SELECT e.from_slot_id AS slot_id, min(e.occurred_at) AS freed_at
          FROM appointment_events e JOIN slots s ON s.id = e.from_slot_id, b
          WHERE e.event_type IN ('cancelled','rescheduled','advanced') AND e.occurred_at >= b.t0 AND e.occurred_at < b.t1
            AND e.occurred_at < s.starts_at GROUP BY 1)
SELECT count(*) AS freed_eligible_slots,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM appointment_events e2 JOIN slots s2 ON s2.id = e2.to_slot_id
                                      WHERE e2.to_slot_id = freed.slot_id AND e2.event_type IN ('booked','rescheduled','advanced')
                                        AND e2.occurred_at > freed.freed_at AND e2.occurred_at < s2.starts_at)) AS recovered_slots
FROM freed;
```

La prueba automatizada comprueba lo siguiente:

- Las operaciones coinciden con las realizadas en la propia prueba: 3 reservas, 1 cancelación y 1 reprogramación.
- La ocupación coincide con la consulta independiente de arriba.
- La suma de la serie diaria y la suma por médico o especialidad coinciden con el resumen.
- La recuperación pasa de 0/2 a 1/2 cuando otro paciente reserva el slot cancelado.
