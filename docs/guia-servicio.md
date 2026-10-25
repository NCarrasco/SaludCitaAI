# Guía documentada del servicio (capa 2 de la conversación)

Esta es la **única** información sobre SaludCita que el modelo puede usar al conversar. Cada afirmación corresponde a algo implementado y verificado. El código equivalente está en `apps/api/src/modules/conversation/service-guide.ts`: si cambia el sistema, hay que actualizar ambos.

| Tema | Lo que el asistente puede afirmar |
|---|---|
| Qué es | Asistente de citas de consulta externa de un hospital **simulado** en República Dominicana. Todos los datos son ficticios |
| Qué hace | Reservar, consultar, cambiar (con el mismo médico) y cancelar citas. Pasar una solicitud al personal administrativo: queda en su bandeja y no es atención inmediata |
| Confirmación | Solo con el botón «Confirmar». El horario se vuelve a comprobar en ese momento |
| Comprobante | Tras confirmar o cambiar una cita se genera un PDF numerado (un cambio produce uno nuevo) que se descarga en «Mis citas». Si falla, se puede reintentar |
| Avisos | Solo en la pestaña Avisos: confirmaciones, recordatorios (unas 24 h y 1 h antes) y ofertas de adelanto si se libera un horario antes con el mismo médico. **No** se envían SMS, correos ni llamadas |
| Acceso | Sin registro. La sesión queda en el dispositivo. Para volver desde otro dispositivo: código de recuperación más fecha de nacimiento |
| Datos que se piden | Solo nombre y fecha de nacimiento (ficticios). No se pide cédula ni datos clínicos |
| Límites médicos | No da diagnósticos, tratamientos, interpretación de resultados ni recomendaciones de medicamentos. Urgencias: emergencias o 9-1-1 |
| Sin información documentada | Precios, seguros, dirección, teléfono y horario general de atención. El asistente debe decir que no tiene esa información |
| Idiomas | Agenda y confirmaciones con textos verificados en **español e inglés**. En otros idiomas el asistente intenta conversar, pero los datos de agenda se muestran en español con un aviso. **No hay voz** |
| Catálogo | Especialidades y médicos ficticios, leídos de PostgreSQL en cada consulta |

## Las cuatro capas

1. **Conversación general** (generada por el modelo y validada). No modifica nada.
2. **Información del servicio:** esta guía.
3. **Agenda:** horarios, citas y referencias leídos de PostgreSQL por la API, con textos verificados.
4. **Operaciones:** reservar, cambiar y cancelar. Solo con el botón «Confirmar». La conversación libre no puede confirmar, cambiar la identidad ni los permisos, ni saltarse las reglas de reserva.

## Información institucional con datos verificados (24-oct-2026)

Las preguntas sobre el servicio no las responde el modelo: el intérprete marca el tema (`service_topic`) y la rama
«informacion» de n8n devuelve una respuesta construida con datos vigentes de PostgreSQL o con hechos documentados.

| Tema | Fuente |
|---|---|
| Horarios de consulta | `schedule_rules` vigentes por médico y especialidad; los días sin consulta se derivan de los datos |
| Precios, seguros y formas de pago | `doctor_services.price_dop`, `centers.accepted_insurers`, `centers.payment_methods` (ficticios, seed 003) |
| Dirección, teléfono, correo y notas | `centers` (ficticios; teléfono 555 y dominio `.example`) |
| Especialidades y médicos | Catálogo activo |
| Normas (antelación, horizonte, confirmación) | `doctor_services.min_notice_minutes` y `booking_horizon_days` + reglas implementadas |
| Comprobantes, avisos, acceso, funciones | Hechos documentados en `service-info.ts` |

Si un dato no está registrado (p. ej., un centro sin teléfono, un servicio sin precio o un tema sin información), la
respuesta dice que no se puede confirmar. El texto generado por el modelo en la charla no puede afirmar horarios,
comprobantes, precios, seguros ni direcciones (el validador lo rechaza y se usa el texto verificado).
