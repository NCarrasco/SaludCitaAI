// Capa 2: información DOCUMENTADA del servicio. Es la única fuente que el modelo puede usar para responder
// preguntas sobre SaludCita. Todo lo que aquí se afirma está implementado y verificado (ver docs/guia-servicio.md).
// El catálogo (especialidades y médicos ficticios) se lee de PostgreSQL en cada consulta.

import type { PoolClient } from '../../db/pool.js';

export const SERVICE_FACTS = [
  'SaludCita es un asistente de citas de consulta externa de un hospital SIMULADO en República Dominicana; todos los datos son ficticios.',
  'Puede: reservar una cita nueva, consultar las citas propias, cambiarlas (mismo médico) o cancelarlas, y pasar una solicitud al personal administrativo (queda en su bandeja; no es atención inmediata).',
  'Las reservas, cambios y cancelaciones solo se hacen cuando el paciente pulsa el botón «Confirmar»; el horario se vuelve a comprobar en ese momento.',
  'Tras confirmar o cambiar una cita se genera un comprobante en PDF (numerado: un cambio produce uno nuevo) que el paciente descarga en la pestaña «Mis citas»; si falla, se puede reintentar.',
  'Avisos: solo en la bandeja de la aplicación (pestaña Avisos): confirmaciones, recordatorios unas 24 h y 1 h antes, y ofertas de adelanto si se libera un horario antes con el mismo médico y el paciente lo pidió. No se envían SMS, correos ni llamadas.',
  'Acceso: no hace falta registrarse; la sesión queda en este dispositivo. Para volver desde otro dispositivo se usa el código de recuperación más la fecha de nacimiento.',
  'Para reservar se piden solo nombre y fecha de nacimiento (ficticios). No se pide cédula ni datos clínicos.',
  'No da diagnósticos, tratamientos, interpretación de resultados ni recomendaciones de medicamentos. En una urgencia: acudir a emergencias o llamar al 9-1-1.',
  'Precios, seguros, formas de pago, dirección, teléfono y horarios de consulta están registrados (ficticios) y los da el sistema con datos verificados; no los afirmes tú.',
  'Idiomas: las respuestas de agenda y confirmaciones tienen textos verificados en español e inglés; en otros idiomas el asistente intenta conversar, pero los datos de agenda se muestran en español. No hay voz.',
];

/** compact: para charla general (menos contexto = menos latencia en CPU); full: preguntas sobre el servicio */
export async function serviceGuide(c: PoolClient, detail: 'compact' | 'full' = 'full'): Promise<string> {
  if (detail === 'compact') {
    const sp = (await c.query(`SELECT name FROM specialties WHERE active ORDER BY name`)).rows.map((r) => r.name);
    return [SERVICE_FACTS[0], SERVICE_FACTS[1], SERVICE_FACTS[6], `Especialidades: ${sp.join(', ')}.`].map((f) => `- ${f}`).join('\n');
  }
  const sp = (await c.query(`SELECT name FROM specialties WHERE active ORDER BY name`)).rows.map((r) => r.name);
  const docs = (await c.query(
    `SELECT DISTINCT d.display_name, s.name AS specialty FROM doctors d JOIN doctor_services ds ON ds.doctor_id = d.id
       JOIN specialties s ON s.id = ds.specialty_id WHERE ds.active ORDER BY 1`)).rows
    .map((r) => `${r.display_name} (${r.specialty})`);
  return [...SERVICE_FACTS, `Especialidades disponibles: ${sp.join(', ')}.`, `Médicos (ficticios): ${docs.join('; ')}.`].map((f) => `- ${f}`).join('\n');
}
