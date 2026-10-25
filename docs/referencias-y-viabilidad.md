# Referencias y viabilidad del MVP

Revisión: 23 de octubre de 2026. Criterio del equipo: herramientas factibles, sin suscripciones adicionales obligatorias. El VPS Contabo ya elegido tiene coste; software gratuito no significa infraestructura gratuita.

## Referencias consultadas

| Referencia primaria | Qué aporta | Aplicación a SaludCita AI |
|---|---|---|
| [Hyro Scheduling](https://www.hyro.ai/solutions/scheduling/) | El proveedor describe conversación para identificar al paciente y consultar opciones conforme a reglas de agenda | Referencia funcional de conversación; no contratar ni integrar su plataforma. Sus afirmaciones comerciales no prueban nuestro desempeño |
| [OpenMRS Scheduling](https://github.com/openmrs/openmrs-module-appointmentscheduling) y [configuración O3](https://o3-docs.openmrs.org/en-US/docs/configure-o3/configure-patient-management/) | Agenda de proveedores, citas y estados de atención | Separar disponibilidad, reserva y asistencia. No incorporar un expediente clínico completo ni desplegar OpenMRS para esta demo |
| [Zocdoc: disponibilidad](https://www.zocdoc.com/blog/facts/real-time-availability-instant-booking/) | Describe disponibilidad conectada al sistema de agenda y reglas por tipo/duración de visita | Mostrar únicamente horarios obtenidos de nuestra API; aclarar que nuestro calendario externo es espejo unidireccional |
| [FHIR Schedule](https://hl7.org/fhir/R5/schedule.html), [Slot](https://hl7.org/fhir/R5/slot.html), [Appointment](https://hl7.org/fhir/R5/appointment.html) | Separa agenda, intervalo reservable y cita; contempla cancelaciones y espera | Referencia conceptual para entidades y estados; no afirmar conformidad FHIR ni implementar servidor FHIR |

## Precisiones para implementar

1. Conservar la separación `schedule_rules`/`slots`/`appointments`. La cita no se confunde con un evento de Google Calendar.
2. Añadir a `doctor_services`: `consultation_kind` (initial/follow_up), `patient_instructions` nullable y longitud limitada, `booking_horizon_days` y `min_notice_minutes` no negativos. Incluir consultation_kind en su combinación única. Seed inicial puede usar solo initial; los siguientes tipos no exigen priorización clínica ni historiales.
3. Añadir a `appointments`: `booking_reference` único, generado por servidor y apto para mostrar al paciente, `source_channel` (gradio), `cancellation_reason_code` nullable y `cancelled_by_type` nullable. Motivos administrativos opcionales (patient_request/provider_unavailable/scheduling_error/other), sin texto clínico. La referencia no autentica al paciente ni autoriza acceso público.
4. Guardar en eventos las versiones y valores administrativos necesarios para reconstruir cambios de agenda. Validar reglas de horizonte/anticipación en búsqueda, intención y confirmación, no solo en la UI.
5. Las ofertas existentes son para adelantar citas ya reservadas. No prometer una lista de espera para personas sin cita: esa funcionalidad se pospone. Las instrucciones del bot deben decirlo cuando no haya disponibilidad y ofrecer ampliar filtros o ayuda administrativa.
6. `completed` significa atención registrada por operador; las reservas por sí solas no acreditan asistencia. No añadir check-in, seguros, pagos, tutores, recurrencias o múltiples participantes al MVP.
7. Probar ausencia médica, feriados mediante excepciones, falta de horarios, tipo de consulta incompatible y cambio de reglas entre selección y confirmación.

## Componentes sin suscripciones obligatorias

- Gradio autoalojado y PostgreSQL como interfaz y persistencia.
- n8n Community autoalojado para automatización; revisar y conservar sus condiciones de licencia con la entrega. No depender de n8n Cloud ni funciones Enterprise.
- Ollama local con un modelo pequeño de pesos descargables cuya licencia permita este uso. Es candidato para conversación sin cargos por petición; no es una garantía de calidad o velocidad en el VPS.
- API TypeScript y Docker Compose sin servicios administrados obligatorios. Revisar condiciones del entorno Docker utilizado por cada integrante.
- Calendario interno operativo desde el inicio. Google Calendar como integración externa con cuenta y OAuth; comprobar cuotas y condiciones actuales de la cuenta antes de comprometer coste cero. Si se omite esta integración, marcarla pendiente, no simular su éxito.

## IA: criterio de selección actualizado

La propuesta anterior de OpenAI pasa a opción adicional, no requisito de ejecución: su API puede generar cargos. El objetivo inicial es validar Ollama y un modelo pequeño, preferiblemente cuantizado, primero en local. No fijar modelo sin comprobar licencia, español, salida estructurada y compatibilidad con la versión de n8n.

El VPS observado tiene 4 CPU y aproximadamente 8 GiB de RAM; no se verificó GPU. PostgreSQL, n8n y la API comparten recursos con el modelo. Por ello ejecutar una petición de IA a la vez al principio y medir memoria total, latencia y errores con el resto del sistema activo. No prometer que cualquier agente local funcionará fluidamente.

Si el agente con herramientas falla la batería, usar interpretación de intención/entidades con JSON validado y una máquina de estados determinista que llama a la API. Esto mantiene conversación asistida por IA sin depender de decisiones libres del modelo. El menú guiado es recuperación ante fallo, no evidencia de funcionamiento de IA. Ajustar el presupuesto conversacional solo a partir de mediciones y mostrar un estado de procesamiento.

No usar créditos promocionales ni APIs gratuitas de terceros como dependencia de reproducibilidad. Si el modelo local no supera las pruebas con los recursos existentes, informar el límite y decidir con el equipo entre reducir alcance conversacional o habilitar una API con presupuesto explícito. No activar costes automáticamente.

Fuentes de viabilidad: [Ollama FAQ](https://docs.ollama.com/faq), [n8n Ollama Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatollama), [Gradio](https://github.com/gradio-app/gradio), [cuotas de Google Calendar](https://developers.google.com/workspace/calendar/api/guides/quota).

Esta revisión es de documentación pública; no se ejecutaron ni auditaron los sistemas de referencia y no se ha probado aún el modelo local.
