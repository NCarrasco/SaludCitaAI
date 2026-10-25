# Guion de demostración (estado de la entrega 5)

Duración: unos 12 minutos. Antes de empezar, levanta el sistema (README §1) y ejecuta la demo trazable:

```bash
node scripts/demo-trace.mjs
```

Esa ejecución comprueba en su fuente cada paso: la base de datos, la ejecución de n8n y el registro de Ollama. Sirve como respaldo si algo falla en vivo.

| # | Qué se muestra | Dónde | Quién lo ejecuta |
|---|---|---|---|
| 1 | Paciente escribe «Quiero una cita de cardiología el martes por la mañana» | Gradio http://127.0.0.1:7860 (paciente01–20) | API recibe → **n8n** reclama → **Ollama** interpreta → API aplica reglas |
| 2 | Ejecución correspondiente en n8n | Editor n8n http://127.0.0.1:5678 → Executions → «SaludCita · Conversación» (modo webhook) | n8n |
| 3 | Horarios reales con fecha completa; elegir uno; **Confirmar** | Gradio | API (transacción con idempotencia) |
| 4 | Petición con saludo delante («Buenas, quería turno con pediatría»): aclaración con botones | Gradio | n8n + Ollama; aclaración por reglas |
| 5 | Mis citas; cancelar con confirmación | Gradio | API |
| 6 | Oferta de adelanto: otro paciente con ofertas activadas acepta desde Avisos; cascada | Gradio (dos sesiones) o `scripts/demo-trace.mjs` parte B | API; el vencimiento lo procesa el **Planificador de n8n** |
| 7 | Estadísticas: actividad, ocupación, ofertas y recuperación, calidad del asistente con aclaraciones | Panel http://127.0.0.1:8080/panel/ (panel@, operador@, admin@) | API |
| 8 | Ausencia administrativa: simulación de impacto con la cita en conflicto, que no se cancela | Panel → Configuración → Agenda | API |
| 9 | Google Calendar | — | **Pendiente**: no se muestra; explicar el estado (docs/google-calendar.md) |

Mensajes clave:

- La IA interpreta y la API ejecuta.
- Nada se confirma sin el botón.
- Los resultados del modelo son limitados (reserved-v2: 7/24 intenciones del modelo; 21/24 aceptables del sistema con aclaraciones; 11/24 directos).
- Es un hospital simulado con datos ficticios.
