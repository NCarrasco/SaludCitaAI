import { expect, type Page, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVICE, adminSession, bookFree, cancelAppointment, clearUpcoming, confirmOrder, env, myOffers, patientToken } from '../helpers';

// Panel en vivo: cambios hechos desde el chat (Gradio) o por la API aparecen en el panel SIN recargar.
// Latencia medida desde el commit (occurred_at del evento en PostgreSQL) hasta que el cambio es visible.
test.use({ storageState: '.auth/admin.json' });
const V1 = `${env.API}/api/v1`;
const latencies: { step: string; ms: number }[] = [];

let adminCall: Awaited<ReturnType<typeof adminSession>> | null = null;
async function occurredAt(ref: string, kind: string) {
  const admin = (adminCall ??= await adminSession('admin@saludcita.test'));
  const d = (await admin('GET', '/admin/dashboard')).json;
  const e = d.activity.find((x: { reference?: string; kind: string }) => x.reference === ref && x.kind === kind);
  return e ? Date.parse(e.occurred_at) : null;
}
/** Espera a que el texto aparezca en el panel sin recargar y registra la latencia desde el commit. */
async function seen(page: Page, step: string, ref: string, kind: string, label: RegExp) {
  const feed = page.locator('.dash-activity .rows');
  await expect(feed.locator('li').filter({ hasText: ref }).filter({ hasText: label }).first()).toBeVisible({ timeout: 15_000 });
  const at = Date.now();
  const committed = await occurredAt(ref, kind);
  if (!committed) throw new Error(`no se encontró el evento ${kind} de ${ref} en la portada`);
  latencies.push({ step, ms: at - committed });
}
async function openPanel(page: Page) {
  await page.goto(`${env.API}/panel/#/inicio`);
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await expect(page.locator('.live-status')).toContainText('En vivo');
}

test.afterAll(() => {
  writeFileSync('test-results/latencias-panel.json', JSON.stringify(latencies, null, 1));
});

test('Gradio → panel: reservar, reprogramar, cancelar y adelantar aparecen sin recargar', async ({ page, browser }) => {
  await openPanel(page);
  const navigations: string[] = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

  // 1) Reserva desde Gradio (botones del chat → orden → n8n)
  const user = 'paciente11';
  const token = await patientToken(user);
  await clearUpcoming(token);
  const gctx = await browser.newContext();
  const g = await gctx.newPage();
  const r = await g.request.post(`${env.GRADIO}/acceso/demo`, { headers: { 'x-saludcita-ui': '1' }, data: { username: user, password: env.patientPassword } });
  expect(r.status()).toBe(200);
  await g.goto(`${env.GRADIO}/chat/`);
  await g.getByRole('button', { name: 'Reservar cita', exact: true }).click();
  await g.getByRole('button', { name: 'Cardiología', exact: true }).click();
  await g.getByRole('button', { name: /^1 · / }).click();
  const confirmations = g.getByRole('log').getByText(/quedó confirmada para el/);
  const before = await confirmations.count();                      // el historial del chat persiste: se espera una NUEVA
  await g.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(confirmations).toHaveCount(before + 1, { timeout: 45_000 });
  const confirmed = confirmations.last();
  const ref = (await confirmed.textContent())!.match(/SC-[A-Z2-9]{6}/)![0];
  await seen(page, 'reserva (Gradio)', ref, 'booked', /Reserva/);
  await gctx.close();

  // 2) Reprogramación
  const appts = (await (await fetch(`${V1}/appointments?scope=upcoming`, { headers: { authorization: `Bearer ${token}` } })).json()).items;
  const ap = appts.find((a: { booking_reference: string }) => a.booking_reference === ref);
  const slots = (await (await fetch(`${V1}/availability?doctor_service_id=${ap.slot.doctor_service_id ?? SERVICE.sosa}&from=${encodeURIComponent(new Date(Date.now() + 2 * 86400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 25 * 86400_000).toISOString())}&limit=5`,
    { headers: { authorization: `Bearer ${token}` } })).json()).items;
  let p: { intent_id?: string; token?: string; error?: { message: string } } = {};
  for (const target of slots.filter((s: { slot_id: string }) => s.slot_id !== ap.slot.slot_id)) {
    p = await (await fetch(`${V1}/action-intents`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'reschedule', appointment_id: ap.id, expected_version: ap.version, new_slot_id: target.slot_id }) })).json();
    if (p.intent_id) break;
  }
  expect(p.intent_id, JSON.stringify(p.error)).toBeTruthy();
  expect((await confirmOrder(token, p.intent_id!, p.token!)).status).toBe(200);
  await seen(page, 'reprogramación', ref, 'rescheduled', /Cambio/);

  // 3) Cancelación de otra cita con oferta de adelanto y 4) aceptación del adelanto
  const ta = await patientToken('paciente12'); const tb = await patientToken('paciente13');
  await clearUpcoming(ta); await clearUpcoming(tb);
  const A = await bookFree(ta, SERVICE.taveras, { skip: 2 });
  const B = await bookFree(tb, SERVICE.taveras, { optIn: true, after: A.slot.starts_at, skip: 1 });
  await seen(page, 'reserva (API)', B.booking_reference, 'booked', /Reserva/);
  await cancelAppointment(ta, A.id, A.version);
  await seen(page, 'cancelación', A.booking_reference, 'cancelled', /Cancelación/);
  const offer = (await myOffers(tb)).find((o: { status: string; appointment: { id: string } }) => o.status === 'pending' && o.appointment.id === B.id);
  if (offer) {
    const s = await fetch(`${V1}/offers/${offer.id}/answer`, { method: 'POST', headers: { authorization: `Bearer ${tb}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ action: 'accept' }) });
    expect(s.status).toBe(202);
    await seen(page, 'adelanto', B.booking_reference, 'advanced', /Adelanto/);
  }
  // Nada de esto recargó la página
  expect(navigations.filter((u) => !u.includes('#/inicio'))).toEqual([]);
  await page.screenshot({ path: 'test-results/panel-inicio-escritorio.png', fullPage: true });
});

async function openCount(page: Page) {
  const row = page.locator('.dash-attention .pend').filter({ hasText: 'solicitudes de ayuda abiertas' });
  return (await row.count()) ? Number(await row.locator('.pend-n').textContent()) : 0;
}

test('solicitud de ayuda: aparece al crearse y desaparece al resolverla', async ({ page }) => {
  await openPanel(page);
  const t = await patientToken('paciente14');
  const before = await openCount(page);
  const msg = await fetch(`${V1}/conversation/messages`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify({ client_message_id: crypto.randomUUID(), action: { type: 'menu', item: 'handoff' } }) });
  const ref = (await msg.json()).reply.handoff_reference as string;
  await expect.poll(() => openCount(page), { timeout: 10_000 }).toBe(before + 1);
  await page.goto(`${env.API}/panel/#/ayuda`);
  const row = page.getByRole('row').filter({ hasText: ref });
  await row.getByRole('button', { name: `Atender la solicitud ${ref}` }).click();
  const dlg = page.getByRole('dialog', { name: `Solicitud de ayuda ${ref}` });
  await expect(dlg.getByText('Tocó «Hablar con el personal»').last()).toBeVisible();   // contexto de la conversación
  const note = 'Llamé al paciente; todo resuelto (prueba E2E).';
  await dlg.getByLabel(/Qué se hizo/).fill(note);
  await dlg.getByRole('button', { name: 'Marcar resuelta' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(`Solicitud ${ref} resuelta. El paciente la verá en «Avisos» del chat.`)).toBeVisible();
  // El paciente recibe la nota en su bandeja
  const inbox = await (await fetch(`${V1}/notifications`, { headers: { authorization: `Bearer ${t}` } })).json();
  expect(inbox.items.find((n: { kind: string; body: string }) => n.kind === 'handoff_update' && n.body.includes(ref))?.body).toContain(note);
});

test('desconexión real: el panel indica la reconexión y al volver recupera lo ocurrido mientras tanto', async ({ page }) => {
  test.setTimeout(120_000);
  await openPanel(page);
  // Se impide que el panel vuelva a conectarse y se reinicia la API (corta el flujo SSE abierto)
  await page.route('**/api/v1/admin/events', (r) => r.abort());
  const root = resolve(import.meta.dirname, '../../..');
  execSync('docker compose --env-file .env -f infra/compose.yaml restart api', { cwd: root, stdio: 'ignore' });
  await expect(page.locator('.live-status')).not.toContainText('En vivo', { timeout: 20_000 });
  for (let i = 0; i < 60; i++) { if ((await fetch(`${V1}/health/ready`).catch(() => null))?.ok) break; await new Promise((r) => setTimeout(r, 1000)); }
  const t = await patientToken('paciente15');
  await clearUpcoming(t);
  const ap = await bookFree(t, SERVICE.sosa, { skip: 4 });           // ocurre mientras el panel está desconectado
  await page.unroute('**/api/v1/admin/events');
  await expect(page.locator('.live-status')).toContainText('En vivo', { timeout: 20_000 });
  await expect(page.locator('.dash-activity .rows').getByText(ap.booking_reference).first()).toBeVisible({ timeout: 10_000 });
});

test('un formulario abierto no pierde lo escrito cuando llegan cambios', async ({ page }) => {
  await page.goto(`${env.API}/panel/#/configuracion/centro`);
  await expect(page.getByRole('heading', { level: 1, name: 'Configuración' })).toBeVisible();
  await page.getByRole('button', { name: 'Editar ficha' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Notas para pacientes (parqueo, accesos…)').fill('Texto a medio escribir');
  // Otro administrador cambia el catálogo: llega un aviso «catalog» y el panel vuelve a consultar
  const admin = await adminSession('admin@saludcita.test');
  const sp = (await admin('GET', '/admin/catalog')).json.specialties[0];
  await admin('PATCH', `/admin/specialties/${sp.id}`, { name: sp.name });
  await page.waitForTimeout(1500);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Notas para pacientes (parqueo, accesos…)')).toHaveValue('Texto a medio escribir');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
});

test.describe('viewer', () => {
  test.use({ storageState: '.auth/viewer.json' });
  test('ve cifras agregadas sin pacientes ni referencias y también recibe avisos', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('.hourbars, .dash-agenda .state.empty').first()).toBeVisible();
    await expect(page.locator('.dash-activity .ref')).toHaveCount(0);   // sin referencias SC-…
    const before = await page.locator('.dash-activity .rows li').count();
    const t = await patientToken('paciente16');
    await clearUpcoming(t);
    await bookFree(t, SERVICE.sosa, { skip: 6 });
    await expect.poll(async () => page.locator('.dash-activity .rows li').first().textContent(), { timeout: 10_000 }).toMatch(/Reserva/);
    expect(await page.locator('.dash-activity .rows li').count()).toBeGreaterThanOrEqual(Math.min(before, 6));
    await page.screenshot({ path: 'test-results/panel-inicio-viewer.png', fullPage: true });
  });
});
