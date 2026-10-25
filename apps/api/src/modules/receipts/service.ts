// Comprobantes PDF de citas (incremento E). Se generan como comando durable (n8n) DESPUÉS de confirmar la cita:
// si la generación falla, la cita sigue confirmada y el comprobante se puede reintentar.
// Todos los datos salen de PostgreSQL en el momento de generar (datos verificados), nunca del modelo.

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound } from '../../shared/errors.js';
import { spanishLabel } from '../../shared/time.js';
import { enqueue } from '../appointments/effects.js';
import { Page, buildPdf, wrap } from './pdf.js';

const GREEN: [number, number, number] = [0, 112, 92];
const MUTED: [number, number, number] = [77, 93, 102];
const LINE: [number, number, number] = [209, 215, 219];
const SOFT: [number, number, number] = [231, 247, 241];

export interface ReceiptData {
  reference: string; patient: string; specialty: string; doctor: string; center: string; starts_at: Date; minutes: number;
  instructions: string | null; appointment_version: number; receipt_number: number; issued_at: Date; correlation_id: string | null;
}

/** Huella de los datos del comprobante (permite comprobar que no se alteró el contenido). */
export function dataFingerprint(d: ReceiptData): string {
  const canon = JSON.stringify([d.reference, d.patient, d.specialty, d.doctor, d.center, d.starts_at.toISOString(), d.minutes,
    d.appointment_version, d.receipt_number]);
  return createHash('sha256').update(canon).digest('hex');
}

export function renderReceiptPdf(d: ReceiptData, tz: string): Buffer {
  const p = new Page();
  const M = 48;                      // margen
  // Cabecera
  p.rect(0, 0, p.width, 96, GREEN);
  p.text('SaludCita', M, 46, 24, { bold: true, color: [255, 255, 255] });
  p.text('Comprobante de cita', M, 72, 13, { color: [255, 255, 255] });
  p.text('Hospital simulado · datos ficticios', p.width - M, 46, 10, { color: [255, 255, 255], align: 'right' });
  p.text(`Comprobante n.º ${d.receipt_number}`, p.width - M, 72, 10, { color: [255, 255, 255], align: 'right' });
  // Referencia destacada
  p.rect(M, 124, p.width - 2 * M, 74, SOFT);
  p.text('CITA CONFIRMADA', M + 18, 150, 10, { bold: true, color: GREEN });
  p.text(d.reference, M + 18, 182, 26, { bold: true });
  p.text('Referencia de la cita', p.width - M - 18, 150, 9, { color: MUTED, align: 'right' });
  p.text(spanishLabel(d.starts_at, tz), p.width - M - 18, 182, 11, { bold: true, align: 'right' });
  // Detalle
  const rows: [string, string][] = [
    ['Paciente', d.patient], ['Especialidad', d.specialty], ['Médico', d.doctor], ['Centro', d.center],
    ['Fecha y hora', spanishLabel(d.starts_at, tz)], ['Duración', `${d.minutes} minutos`], ['Estado', 'Confirmada'],
    ['Versión de la cita', String(d.appointment_version)],
  ];
  let y = 236;
  for (const [k, v] of rows) {
    p.text(k, M, y, 10, { color: MUTED });
    p.text(v, M + 150, y, 11, { bold: k === 'Fecha y hora' || k === 'Médico' });
    p.line(M, y + 10, p.width - M, y + 10, LINE);
    y += 28;
  }
  // Indicaciones
  y += 14;
  p.text('Indicaciones', M, y, 12, { bold: true });
  y += 20;
  const notes = [
    d.instructions ? `Indicaciones del servicio: ${d.instructions}` : null,
    'Presenta la referencia de la cita al llegar al centro.',
    'Para cambiar o cancelar la cita, usa el asistente de SaludCita. Las operaciones solo se hacen con tu confirmación.',
    d.receipt_number === 2 ? 'Este comprobante sustituye al anterior de esta cita.'
      : d.receipt_number > 2 ? `Este comprobante sustituye a los ${d.receipt_number - 1} anteriores de esta cita.` : null,
  ].filter(Boolean) as string[];
  for (const n of notes) {
    for (const [i, l] of wrap(n, 10, p.width - 2 * M - 14).entries()) { p.text(`${i === 0 ? '•' : ' '}  ${l}`, M, y, 10); y += 15; }
    y += 3;
  }
  // Pie
  const fp = dataFingerprint(d);
  p.line(M, 760, p.width - M, 760, LINE);
  p.text(`Emitido: ${spanishLabel(d.issued_at, tz)} · Huella de datos: ${fp.slice(0, 16)}`, M, 778, 8, { color: MUTED });
  p.text('Documento administrativo de demostración (UASD, G6). No es un documento médico. Todos los datos son ficticios.', M, 792, 8, { color: MUTED });
  if (d.correlation_id) p.text(`Correlación: ${d.correlation_id}`, M, 806, 7, { color: MUTED });
  return buildPdf(p, { title: `Comprobante ${d.reference} (n.º ${d.receipt_number})`, subject: 'Comprobante de cita SaludCita', created: d.issued_at });
}

/** Genera el PDF de la versión pedida. Si la cita ya cambió, el comprobante queda superado (no es un fallo). */
export async function renderReceipt(c: PoolClient, appointmentId: string, version: number, tz: string) {
  const a = (await c.query(
    `SELECT a.id, a.status, a.version, a.booking_reference, a.starts_at, p.full_name, sp.name AS specialty, d.display_name AS doctor,
            ce.name AS center, ds.slot_minutes, ds.patient_instructions, r.id AS receipt_id, r.receipt_number, r.correlation_id, r.status AS receipt_status
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = s.doctor_id
     JOIN doctor_services ds ON ds.id = s.doctor_service_id JOIN specialties sp ON sp.id = ds.specialty_id JOIN centers ce ON ce.id = ds.center_id
     LEFT JOIN appointment_receipts r ON r.appointment_id = a.id AND r.appointment_version = $2
     WHERE a.id = $1 FOR UPDATE OF a`, [appointmentId, version])).rows[0];
  if (!a || !a.receipt_id) return { outcome: 'missing' as const };
  if (a.status !== 'booked' || a.version !== version) {
    await c.query(`UPDATE appointment_receipts SET status = CASE WHEN status = 'void' THEN 'void' ELSE 'superseded' END WHERE id = $1`, [a.receipt_id]);
    return { outcome: 'superseded' as const, receipt_id: a.receipt_id as string };
  }
  if (a.receipt_status === 'ready') return { outcome: 'ready' as const, receipt_id: a.receipt_id as string, already: true };
  const data: ReceiptData = { reference: a.booking_reference, patient: a.full_name ?? 'Paciente (sin nombre registrado)', specialty: a.specialty,
    doctor: a.doctor, center: a.center, starts_at: a.starts_at, minutes: a.slot_minutes, instructions: a.patient_instructions,
    appointment_version: a.version, receipt_number: a.receipt_number, issued_at: new Date(), correlation_id: a.correlation_id };
  const pdf = renderReceiptPdf(data, tz);
  const sha = createHash('sha256').update(pdf).digest('hex');
  await c.query(`UPDATE appointment_receipts SET status = 'ready', pdf = $2, sha256 = $3, size_bytes = $4, rendered_at = now(), last_error = NULL WHERE id = $1`,
    [a.receipt_id, pdf, sha, pdf.length]);
  return { outcome: 'ready' as const, receipt_id: a.receipt_id as string, sha256: sha, size_bytes: pdf.length };
}

/** Estado del comprobante vigente de una cita PROPIA (comprobación de propiedad incluida). */
export async function receiptStatus(pool: Pool, patientId: string, appointmentId: string) {
  const r = (await pool.query(
    `SELECT a.id, a.status AS appointment_status, a.version, r.receipt_number, r.status, r.sha256, r.size_bytes, r.rendered_at, r.last_error
     FROM appointments a LEFT JOIN appointment_receipts r ON r.appointment_id = a.id AND r.appointment_version = a.version
     WHERE a.id = $1 AND a.patient_id = $2`, [appointmentId, patientId])).rows[0];
  if (!r) throw notFound('Cita');
  return r;
}

/** PDF del comprobante vigente, solo para el dueño de la cita. */
export async function receiptPdf(pool: Pool, patientId: string, appointmentId: string) {
  const r = (await pool.query(
    `SELECT r.pdf, r.receipt_number, a.booking_reference, r.status FROM appointments a
     JOIN appointment_receipts r ON r.appointment_id = a.id AND r.appointment_version = a.version
     WHERE a.id = $1 AND a.patient_id = $2`, [appointmentId, patientId])).rows[0];
  if (!r) throw notFound('Comprobante');
  if (r.status !== 'ready') throw conflict('receipt_not_ready', r.status === 'failed' ? 'No se pudo generar el comprobante; puedes reintentarlo' : 'El comprobante se está generando');
  return { pdf: r.pdf as Buffer, filename: `comprobante-${r.booking_reference}-n${r.receipt_number}.pdf` };
}

/** Reintento a petición del dueño cuando la generación falló (vuelve a encargar el comando durable). */
export async function retryReceipt(pool: Pool, patientId: string, appointmentId: string) {
  return withTransaction(pool, async (c) => {
    const r = (await c.query(
      `SELECT r.id, r.status, r.correlation_id, a.version FROM appointments a
       JOIN appointment_receipts r ON r.appointment_id = a.id AND r.appointment_version = a.version
       WHERE a.id = $1 AND a.patient_id = $2 AND a.status = 'booked' FOR UPDATE OF r`, [appointmentId, patientId])).rows[0];
    if (!r) throw notFound('Comprobante');
    if (r.status !== 'failed') throw conflict('receipt_not_failed', 'El comprobante no está en estado fallido');
    await c.query(`UPDATE appointment_receipts SET status = 'pending', last_error = NULL WHERE id = $1`, [r.id]);
    const attempt = (await c.query(`SELECT count(*)::int n FROM outbox_jobs WHERE dedupe_key LIKE $1`, [`receipt:${appointmentId}:v${r.version}%`])).rows[0].n;
    await enqueue(c, 'receipt.render', appointmentId, `receipt:${appointmentId}:v${r.version}:retry${attempt}`, { appointment_id: appointmentId, version: r.version },
      undefined, r.correlation_id);
    return { status: 'pending' };
  });
}
