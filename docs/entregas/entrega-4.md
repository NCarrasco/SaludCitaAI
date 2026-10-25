# Entrega 4: automatizaciones

> **Estado de Google Calendar: PENDIENTE.** Hay un workflow importado (sin publicar) y pruebas de la cola con un cliente simulado. **Eso no equivale a una integración terminada**: no se ha creado, reprogramado ni cancelado ningún evento real en Google Calendar. La integración solo se dará por terminada cuando se pruebe con credenciales OAuth de una cuenta de prueba y quede evidencia.

Fecha: 23 de octubre de 2026. Todo en local; sin conexión a Contabo.

## Qué funciona (verificado)

- **Ofertas secuenciales de adelanto con cascada**:
  - una oferta pendiente por ronda;
  - candidatos del mismo servicio con ofertas activadas, ordenados por fecha;
  - el horario queda retenido mientras dura la ronda;
  - ventana de 1 h y modo demo explícito;
  - sin la ventana completa antes del inicio, el horario va a reserva directa;
  - aceptar, rechazar y vencer, con invalidación si la cita cambia o el horario se bloquea;
  - cascada tras cada aceptación.
- **Paciente:** ve y responde las ofertas en la pestaña Avisos de Gradio. Lo verifiqué en el navegador aceptando una oferta real.
- **Planificador n8n** (publicado, cada minuto): vence ofertas y emite las siguientes, publica recordatorios de 24 h y 1 h solo de citas vigentes, recupera leases y amplía la agenda.
- **Cola durable:** reclamación con lease y `SKIP LOCKED`, un trabajo por cita, `ack`/`fail`, backoff exponencial con jitter, estado `dead` y reintento desde el panel. Los trabajos obsoletos se reemplazan y la versión sincronizada nunca retrocede.
- **Reinicio:** tras `compose down/up` se conservan los datos y n8n procesa los trabajos pendientes en menos de un minuto.
- **Panel:** estadísticas de ofertas reales y texto de la cola actualizado.

## No terminado

- **Google Calendar:** el workflow está escrito e importado **sin publicar**. Falta la credencial OAuth de una cuenta de prueba y **no se ha probado contra Google**. El panel lo muestra como «Pendiente de credenciales». Los pasos de activación están en [docs/automatizaciones.md](../automatizaciones.md). La lógica de cola y convergencia está probada en la API con un cliente simulado; según el encargo, eso **no** cuenta como integración real.

## Criterios de aceptación cubiertos

| Criterio | Evidencia |
|---|---|
| Aceptación, rechazo, vencimiento, candidata modificada, ronda agotada, horario cercano al inicio y cascada de al menos dos aceptaciones | `offers-jobs.test.ts` |
| Carrera entre aceptación y vencimiento sin inconsistencias | `offers-jobs.test.ts`: aceptación y dos ticks en paralelo, con oferta vencida y vigente |
| Carrera entre reserva y oferta | Un horario en oferta rechaza la reserva pública (`held_by_offer`) |
| Reiniciar contenedores conserva datos y recupera trabajos | reinicio-recuperacion.txt (carpeta de evidencias) |
| El calendario converge al estado vigente | Probado en la API (create → update → delete, trabajo reemplazado, `ack` tardío sin retroceso). **Sin Google real** |
| No se envían recordatorios de versiones canceladas | `offers-jobs.test.ts` |

## Comandos ejecutados y resultados

```text
cd apps/api && npm test                     → 10 archivos, 97 pruebas superadas (11 nuevas de la entrega 4; 3 ejecuciones estables)
npm run openapi:lint                        → válido
node scripts/e2e-offers-n8n.mjs             → 9/9 (n8n venció la oferta en 29 s)
node scripts/smoke-test.mjs                 → 16/16
compose down/up con trabajos pendientes     → procesados en 56 s, sin pérdida de datos
Gradio: aceptar oferta en el navegador      → cita adelantada y aviso publicado
```

Evidencias en docs/evidencias/entrega-4/ (carpeta de evidencias).

## Defectos encontrados y corregidos durante la entrega

1. El ayudante de idempotencia revertía la transición al vencer o invalidar una oferta. Ahora se confirma y después se responde 410/409.
2. Si el planificador vencía la oferta antes, la aceptación respondía 409 en lugar de 410. Ahora responde 410 siempre.
3. Al bloquear un horario con una ronda abierta, la oferta pendiente no se invalidaba. Ahora se invalida.
4. Había textos con doble punto («a. m..») en los avisos de oferta.

## Pendiente antes de cerrar el MVP

- Google Calendar real (credenciales, prueba y evidencia).
- Mejora conversacional ante intención incierta, medida con la batería reservada `reserved-v2`.
- Medición en Contabo.
- Entrega 5: verificación integral, instalación desde una copia limpia, backup y restauración, y guía de despliegue.
