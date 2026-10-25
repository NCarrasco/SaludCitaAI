// Confirmación orquestada por n8n: «Confirmar» registra la orden (comando durable appointment.confirm), n8n la reclama
// y la API la ejecuta. n8n se SIMULA llamando a los mismos endpoints que el workflow «Comandos durables»; la prueba con
// n8n real está en scripts/orchestration-check.mjs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { P, SERVICE, auth, book, confirm, freeSlots, login, prepare, resetAgenda, setupApp, teardown, type Ctx } from '../helpers/app.js';
import { TEST_SERVICE_SECRET } from '../helpers/env.js';

let ctx: Ctx;
const SVC = auth(`svc_${TEST_SERVICE_SECRET}`);
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await teardown(ctx); });
beforeEach(async () => { await resetAgenda(ctx); });

const submit = (t: string, id: string, token: string, key = randomUUID()) => ctx.app.inject({
  method: 'POST', url: `${P}/action-intents/${id}/submit`, headers: { ...auth(t), 'idempotency-key': key }, payload: { token } });
const status = async (t: string, id: string) => (await ctx.app.inject({ method: 'GET', url: `${P}/action-intents/${id}/confirmation`, headers: auth(t) })).json();
const claim = async () => (await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/claim`, headers: SVC,
  payload: { kinds: ['appointment.confirm'] } })).json().items;
const execute = (id: string, lease: string) => ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${id}/confirm`, headers: SVC,
  payload: { lease_token: lease } });

async function preparedBooking(n: number, skip = 30) {
  const t = await login(ctx, n);
  const [s] = await freeSlots(ctx, SERVICE.sosa, 1, skip);
  const p = (await prepare(ctx, t, { kind: 'booking', slot_id: s!.slot_id })).json();
  return { t, slot: s!.slot_id, p };
}

describe('Confirmación orquestada por n8n', () => {
  it('enviar no toca la agenda; n8n ejecuta y la cita, sus eventos y su PDF comparten el correlation_id de la orden', async () => {
    const { t, slot, p } = await preparedBooking(4);
    const r = await submit(t, p.intent_id, p.token);
    expect(r.statusCode).toBe(202);
    const order = r.json();
    expect(order.status).toBe('queued');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1 AND status = 'booked'`, [slot])).rows[0].n).toBe(0);
    expect((await status(t, p.intent_id)).status).toBe('queued');

    const [cmd] = await claim();
    expect(cmd.kind).toBe('appointment.confirm');
    expect(cmd.correlation_id).toBe(order.correlation_id);
    expect((await status(t, p.intent_id)).status).toBe('running');
    const ex = await execute(cmd.command_id, cmd.lease_token);
    expect(ex.statusCode).toBe(200);
    expect((await execute(cmd.command_id, cmd.lease_token)).json().result).toEqual(ex.json().result);   // reintento idempotente

    const st = await status(t, p.intent_id);
    expect(st.status).toBe('confirmed');
    expect(st.result.outcome).toBe('booked');
    const apptId = st.result.appointment.id;
    const ev = (await ctx.db.query(`SELECT correlation_id FROM appointment_events WHERE appointment_id = $1`, [apptId])).rows;
    expect(ev.map((e) => e.correlation_id)).toEqual([order.correlation_id]);
    const receipt = (await ctx.db.query(`SELECT correlation_id FROM outbox_jobs WHERE aggregate_id = $1 AND kind = 'receipt.render'`, [apptId])).rows;
    expect(receipt.map((j) => j.correlation_id)).toEqual([order.correlation_id]);
  });

  it('enviar dos veces (misma u otra clave) devuelve la misma orden; un solo comando', async () => {
    const { t, p } = await preparedBooking(5);
    const key = randomUUID();
    const a = (await submit(t, p.intent_id, p.token, key)).json();
    const b = (await submit(t, p.intent_id, p.token, key)).json();
    const c = (await submit(t, p.intent_id, p.token)).json();
    expect(b.command_id).toBe(a.command_id);
    expect(c.command_id).toBe(a.command_id);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM outbox_jobs WHERE kind = 'appointment.confirm' AND aggregate_id = $1`,
      [p.intent_id])).rows[0].n).toBe(1);
  });

  it('token incorrecto → 403; intención de otro paciente → 404; sin enviar no hay estado', async () => {
    const { t, p } = await preparedBooking(6);
    expect((await submit(t, p.intent_id, 'int_' + 'x'.repeat(30))).statusCode).toBe(403);
    const other = await login(ctx, 7);
    expect((await submit(other, p.intent_id, p.token)).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `${P}/action-intents/${p.intent_id}/confirmation`, headers: auth(t) })).statusCode).toBe(409);
  });

  it('si el horario se ocupa antes de que n8n ejecute, el resultado es un rechazo sin cambios y no se reintenta', async () => {
    const { t, slot, p } = await preparedBooking(8);
    await submit(t, p.intent_id, p.token);
    const rival = await login(ctx, 9);
    expect((await book(ctx, rival, slot)).status).toBe('booked');
    const [cmd] = await claim();
    expect((await execute(cmd.command_id, cmd.lease_token)).statusCode).toBe(200);
    const st = await status(t, p.intent_id);
    expect(st.status).toBe('failed');
    expect(st.error.status).toBe(409);
    expect((await ctx.db.query(`SELECT status FROM outbox_jobs WHERE id = $1`, [cmd.command_id])).rows[0].status).toBe('done');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1`, [slot])).rows[0].n).toBe(1);   // solo la del rival
  });

  it('con n8n caído la orden vence a los 120 s: se descarta sin cambios y ya no se ejecutará', async () => {
    const { t, slot, p } = await preparedBooking(10);
    const order = (await submit(t, p.intent_id, p.token)).json();
    await ctx.db.query(`UPDATE outbox_jobs SET payload = jsonb_set(payload, '{deadline}', to_jsonb(to_char((now() - interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id = $1`,
      [order.command_id]);
    const st = await status(t, p.intent_id);
    expect(st.status).toBe('expired');
    expect(await claim()).toHaveLength(0);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1`, [slot])).rows[0].n).toBe(0);
  });

  it('preparar otra operación no invalida una orden ya enviada (está en curso en n8n)', async () => {
    const { t, p } = await preparedBooking(11);
    await submit(t, p.intent_id, p.token);
    const [s2] = await freeSlots(ctx, SERVICE.sosa, 1, 60);
    await prepare(ctx, t, { kind: 'booking', slot_id: s2!.slot_id });
    const [cmd] = await claim();
    await execute(cmd.command_id, cmd.lease_token);
    expect((await status(t, p.intent_id)).status).toBe('confirmed');
  });
});

describe('Respuesta a un adelanto orquestada por n8n', () => {
  const answer = (t: string, id: string, action: 'accept' | 'reject', key = randomUUID()) => ctx.app.inject({
    method: 'POST', url: `${P}/offers/${id}/answer`, headers: { ...auth(t), 'idempotency-key': key }, payload: { action } });
  const answerStatus = async (t: string, id: string) => (await ctx.app.inject({ method: 'GET', url: `${P}/offers/${id}/answer`, headers: auth(t) })).json();
  const claimOffer = async () => (await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/claim`, headers: SVC,
    payload: { kinds: ['offer.answer'] } })).json().items;
  const executeOffer = (id: string, lease: string) => ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${id}/offer-answer`,
    headers: SVC, payload: { lease_token: lease } });

  /** A cancela su cita: B (con aviso de adelanto activado) recibe la oferta. */
  async function offerToB() {
    const s = await freeSlots(ctx, SERVICE.taveras, 2, 6);
    const ta = await login(ctx, 12); const tb = await login(ctx, 13);
    const A = await book(ctx, ta, s[0]!.slot_id);
    const B = await book(ctx, tb, s[1]!.slot_id, { advance_opt_in: true });
    const p = (await prepare(ctx, ta, { kind: 'cancellation', appointment_id: A.id, expected_version: 1 })).json();
    expect((await confirm(ctx, ta, p.intent_id, p.token)).statusCode).toBe(200);
    const off = (await ctx.db.query(`SELECT id FROM advance_offers WHERE appointment_id = $1 AND status = 'pending'`, [B.id])).rows[0];
    return { tb, B, offerId: off.id as string, target: s[0]!.slot_id };
  }

  it('aceptar registra la orden sin mover la cita; n8n la ejecuta y la cita se adelanta con el correlation_id de la orden', async () => {
    const { tb, B, offerId, target } = await offerToB();
    const r = await answer(tb, offerId, 'accept');
    expect(r.statusCode).toBe(202);
    expect((await ctx.db.query(`SELECT slot_id FROM appointments WHERE id = $1`, [B.id])).rows[0].slot_id).not.toBe(target);
    expect((await answerStatus(tb, offerId)).status).toBe('queued');
    const [cmd] = await claimOffer();
    expect((await executeOffer(cmd.command_id, cmd.lease_token)).statusCode).toBe(200);
    const st = await answerStatus(tb, offerId);
    expect(st.status).toBe('done');
    const b = (await ctx.db.query(`SELECT slot_id, version FROM appointments WHERE id = $1`, [B.id])).rows[0];
    expect(b).toMatchObject({ slot_id: target, version: 2 });
    const ev = (await ctx.db.query(`SELECT correlation_id FROM appointment_events WHERE appointment_id = $1 AND event_type = 'advanced'`, [B.id])).rows;
    expect(ev.map((e) => e.correlation_id)).toEqual([r.json().correlation_id]);
  });

  it('el plazo de la oferta se evalúa cuando el paciente respondió, no cuando n8n ejecuta', async () => {
    const { tb, B, offerId, target } = await offerToB();
    await answer(tb, offerId, 'accept');
    await new Promise((r) => setTimeout(r, 20));
    // Vence 1 ms DESPUÉS de que el paciente respondiera, mientras la orden espera en n8n
    await ctx.db.query(`UPDATE advance_offers SET offered_at = now() - interval '2 hours',
      expires_at = (SELECT (payload->>'requested_at')::timestamptz + interval '1 millisecond' FROM outbox_jobs WHERE dedupe_key = 'offer:' || $1 || ':answer')
      WHERE id = $1`, [offerId]);
    await ctx.app.inject({ method: 'POST', url: `${P}/internal/scheduler/tick`, headers: SVC });   // el planificador no la da por vencida
    expect((await ctx.db.query(`SELECT status FROM advance_offers WHERE id = $1`, [offerId])).rows[0].status).toBe('pending');
    const [cmd] = await claimOffer();
    await executeOffer(cmd.command_id, cmd.lease_token);
    expect((await answerStatus(tb, offerId)).status).toBe('done');                                 // respondió a tiempo: vale
    expect((await ctx.db.query(`SELECT slot_id FROM appointments WHERE id = $1`, [B.id])).rows[0].slot_id).toBe(target);
  });

  it('si responde después de vencer, se rechaza al enviar (410) y la cita original se mantiene', async () => {
    const { tb, B, offerId, target } = await offerToB();
    await ctx.db.query(`UPDATE advance_offers SET offered_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`, [offerId]);
    expect((await answer(tb, offerId, 'accept')).statusCode).toBe(410);
    expect((await ctx.db.query(`SELECT slot_id FROM appointments WHERE id = $1`, [B.id])).rows[0].slot_id).not.toBe(target);
  });

  it('cambiar de respuesta mientras se procesa → 409; otro paciente → 404', async () => {
    const { tb, offerId } = await offerToB();
    expect((await answer(tb, offerId, 'reject')).statusCode).toBe(202);
    expect((await answer(tb, offerId, 'accept')).statusCode).toBe(409);
    expect((await answer(await login(ctx, 14), offerId, 'accept')).statusCode).toBe(404);
  });
});

describe('Sin rutas directas: solo el ejecutor interno de n8n ejecuta operaciones', () => {
  it('con n8n detenido no hay forma de confirmar: la ruta directa no existe y la orden queda en cola sin cita', async () => {
    const { t, slot, p } = await preparedBooking(15);
    const direct = await ctx.app.inject({ method: 'POST', url: `${P}/action-intents/${p.intent_id}/confirm`,
      headers: { ...auth(t), 'idempotency-key': randomUUID() }, payload: { token: p.token } });
    expect(direct.statusCode).toBe(404);
    expect((await submit(t, p.intent_id, p.token)).statusCode).toBe(202);
    expect((await status(t, p.intent_id)).status).toBe('queued');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1`, [slot])).rows[0].n).toBe(0);
  });

  it('las rutas antiguas de aceptar o rechazar adelantos ya no existen', async () => {
    const t = await login(ctx, 16);
    for (const a of ['accept', 'reject']) {
      expect((await ctx.app.inject({ method: 'POST', url: `${P}/offers/${randomUUID()}/${a}`, headers: { ...auth(t), 'idempotency-key': randomUUID() } })).statusCode).toBe(404);
    }
  });

  it('una orden vencida no revive: ni con la ruta directa ni reenviando el token original; para reintentar hay que preparar otra', async () => {
    const { t, slot, p } = await preparedBooking(17);
    const order = (await submit(t, p.intent_id, p.token)).json();
    await ctx.db.query(`UPDATE outbox_jobs SET payload = jsonb_set(payload, '{deadline}', to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id = $1`, [order.command_id]);
    expect((await status(t, p.intent_id)).status).toBe('expired');
    expect((await ctx.db.query(`SELECT status FROM action_intents WHERE id = $1`, [p.intent_id])).rows[0].status).toBe('expired');
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/action-intents/${p.intent_id}/confirm`,
      headers: { ...auth(t), 'idempotency-key': randomUUID() }, payload: { token: p.token } })).statusCode).toBe(404);
    const again = (await submit(t, p.intent_id, p.token)).json();                     // misma orden, sigue vencida
    expect(again.command_id).toBe(order.command_id);
    expect((await status(t, p.intent_id)).status).toBe('expired');
    expect(await claim()).toHaveLength(0);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM outbox_jobs WHERE kind = 'appointment.confirm' AND aggregate_id = $1`, [p.intent_id])).rows[0].n).toBe(1);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1`, [slot])).rows[0].n).toBe(0);
    // Reintento correcto: nueva intención (revalida disponibilidad) → nueva orden
    const p2 = (await prepare(ctx, t, { kind: 'booking', slot_id: slot })).json();
    const o2 = (await submit(t, p2.intent_id, p2.token)).json();
    expect(o2.command_id).not.toBe(order.command_id);
  });

  it('un rechazo de negocio cierra la intención: reenviarla no la vuelve a ejecutar', async () => {
    const { t, slot, p } = await preparedBooking(18);
    await submit(t, p.intent_id, p.token);
    await book(ctx, await login(ctx, 19), slot);                                       // el horario se ocupa
    const [cmd] = await claim();
    await execute(cmd.command_id, cmd.lease_token);
    expect((await status(t, p.intent_id)).status).toBe('failed');
    expect((await ctx.db.query(`SELECT status FROM action_intents WHERE id = $1`, [p.intent_id])).rows[0].status).toBe('invalidated');
    expect((await submit(t, p.intent_id, p.token)).json().command_id).toBe(cmd.command_id);
    expect(await claim()).toHaveLength(0);
  });

  it('el ejecutor exige servicio, lease válido y vínculo comando ↔ intención ↔ paciente', async () => {
    const { t, p } = await preparedBooking(20);
    const order = (await submit(t, p.intent_id, p.token)).json();
    // Un paciente no puede llamar al ejecutor interno
    expect((await ctx.app.inject({ method: 'POST', url: `${P}/internal/commands/${order.command_id}/confirm`, headers: auth(t),
      payload: { lease_token: randomUUID() } })).statusCode).toBe(403);
    const [cmd] = await claim();
    expect((await execute(cmd.command_id, randomUUID())).statusCode).toBe(409);       // lease ajeno
    // Comando manipulado para apuntar a la intención de otro paciente
    const other = await preparedBooking(3, 70);
    await ctx.db.query(`UPDATE outbox_jobs SET payload = jsonb_set(payload, '{intent_id}', to_jsonb($2::text)) WHERE id = $1`,
      [cmd.command_id, other.p.intent_id]);
    expect((await execute(cmd.command_id, cmd.lease_token)).statusCode).toBe(409);    // order_mismatch
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE patient_id IN (SELECT patient_id FROM action_intents WHERE id = ANY($1::uuid[]))`,
      [[p.intent_id, other.p.intent_id]])).rows[0].n).toBe(0);
  });
});

describe('Concurrencia determinista: consultas de estado, ejecución y vencimiento', () => {
  /** Resuelve si la promesa termina antes de `ms`; si no, la consulta quedó bloqueada. */
  const settlesWithin = <T>(pr: Promise<T>, ms = 3000) => Promise.race([pr.then((v) => ({ done: true as const, v })),
    new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms))]);
  /** Espera (sin sleeps fijos) a que alguna sesión esté bloqueada esperando un lock de fila. */
  async function waitForLockWaiter() {
    for (let i = 0; i < 300; i++) {
      const n = (await ctx.db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows[0].n;
      if (n > 0) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('ninguna sesión llegó a esperar el bloqueo');
  }

  it('consultar el estado no se bloquea mientras n8n tiene el comando, la intención y el paciente bloqueados', async () => {
    const { t, p } = await preparedBooking(4);
    const order = (await submit(t, p.intent_id, p.token)).json();
    const holder = await ctx.db.connect();
    try {
      await holder.query('BEGIN');
      // Mismo orden que el ejecutor: comando → paciente → intención
      await holder.query(`SELECT 1 FROM outbox_jobs WHERE id = $1 FOR UPDATE`, [order.command_id]);
      await holder.query(`SELECT 1 FROM patients WHERE id = (SELECT patient_id FROM action_intents WHERE id = $1) FOR UPDATE`, [p.intent_id]);
      await holder.query(`SELECT 1 FROM action_intents WHERE id = $1 FOR UPDATE`, [p.intent_id]);
      const r = await settlesWithin(status(t, p.intent_id));
      expect(r.done).toBe(true);
    } finally {
      await holder.query('ROLLBACK'); holder.release();
    }
  });

  it('plazo vencido con el comando YA reclamado: se informa «running», no «expired»; al ejecutarse queda vencido sin cambios', async () => {
    const { t, slot, p } = await preparedBooking(5);
    const order = (await submit(t, p.intent_id, p.token)).json();
    const [cmd] = await claim();
    await ctx.db.query(`UPDATE outbox_jobs SET payload = jsonb_set(payload, '{deadline}', to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id = $1`, [order.command_id]);
    expect((await status(t, p.intent_id)).status).toBe('running');
    expect((await ctx.db.query(`SELECT status FROM outbox_jobs WHERE id = $1`, [cmd.command_id])).rows[0].status).toBe('leased');
    await execute(cmd.command_id, cmd.lease_token);
    expect((await status(t, p.intent_id)).status).toBe('expired');
    expect((await ctx.db.query(`SELECT count(*)::int n FROM appointments WHERE slot_id = $1`, [slot])).rows[0].n).toBe(0);
  });

  it('si el comando termina mientras la consulta intenta vencerlo, se informa el resultado real (no «expired»)', async () => {
    const { t, p } = await preparedBooking(6);
    const order = (await submit(t, p.intent_id, p.token)).json();
    await ctx.db.query(`UPDATE outbox_jobs SET payload = jsonb_set(payload, '{deadline}', to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id = $1`, [order.command_id]);
    const holder = await ctx.db.connect();
    let pending: Promise<any> | null = null;
    try {
      await holder.query('BEGIN');
      // Otra transacción (n8n) cierra el comando como terminado y aún no confirma su transacción
      await holder.query(`UPDATE outbox_jobs SET status = 'done', done_at = now(), result = $2 WHERE id = $1`,
        [order.command_id, JSON.stringify({ error: { code: 'slot_taken', status: 409, message: 'Horario ocupado' } })]);
      pending = status(t, p.intent_id);              // su UPDATE de vencimiento espera el bloqueo de la fila
      await waitForLockWaiter();
      await holder.query('COMMIT');
    } finally { holder.release(); }
    const st = await pending!;
    expect(st.status).toBe('failed');
    expect(st.error.code).toBe('slot_taken');
    expect((await ctx.db.query(`SELECT status FROM outbox_jobs WHERE id = $1`, [order.command_id])).rows[0].status).toBe('done');
  });

  it('consultar la respuesta a un adelanto no se bloquea mientras n8n tiene el comando, el paciente y la oferta bloqueados', async () => {
    const s = await freeSlots(ctx, SERVICE.taveras, 2, 6);
    const ta = await login(ctx, 12); const tb = await login(ctx, 13);
    const A = await book(ctx, ta, s[0]!.slot_id);
    const B = await book(ctx, tb, s[1]!.slot_id, { advance_opt_in: true });
    const pc = (await prepare(ctx, ta, { kind: 'cancellation', appointment_id: A.id, expected_version: 1 })).json();
    expect((await confirm(ctx, ta, pc.intent_id, pc.token)).statusCode).toBe(200);
    const off = (await ctx.db.query(`SELECT id FROM advance_offers WHERE appointment_id = $1 AND status = 'pending'`, [B.id])).rows[0];
    const r = await ctx.app.inject({ method: 'POST', url: `${P}/offers/${off.id}/answer`, headers: { ...auth(tb), 'idempotency-key': randomUUID() },
      payload: { action: 'accept' } });
    const holder = await ctx.db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM outbox_jobs WHERE id = $1 FOR UPDATE`, [r.json().command_id]);
      await holder.query(`SELECT 1 FROM patients WHERE id = (SELECT patient_id FROM appointments WHERE id = $1) FOR UPDATE`, [B.id]);
      await holder.query(`SELECT 1 FROM advance_offers WHERE id = $1 FOR UPDATE`, [off.id]);
      const res = await settlesWithin(ctx.app.inject({ method: 'GET', url: `${P}/offers/${off.id}/answer`, headers: auth(tb) }));
      expect(res.done).toBe(true);
    } finally {
      await holder.query('ROLLBACK'); holder.release();
    }
  });
});
