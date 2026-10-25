import { expect, type Page, test } from '@playwright/test';
import { SERVICE, adminSession, bookFree, cancelAppointment, clearUpcoming, confirmOrder, env, patientToken, pickDate } from '../helpers';

// Indicadores de Inicio: coinciden con la base de datos y cambian SIN recargar cuando alguien reserva, cambia o cancela.
test.use({ storageState: '.auth/admin.json' });
const V1 = `${env.API}/api/v1`;
const TZ = 'America/Santo_Domingo';
const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

async function kpi(page: Page, label: RegExp) {
  // Métricas del día: medidores (.metric) y cifras (.figure); el valor es el primer número (la variación va aparte)
  const card = page.locator('.metrics').locator('.metric, .figure').filter({ has: page.locator('.ring-label, .figure-label', { hasText: label }) });
  const raw = (await card.locator('.ring-value, .figure-value').textContent())!;
  return { value: Number(/^\s*([\d.,]+)/.exec(raw)![1]!.replace(/\D/g, '')), detail: (await card.locator('.ring-caption, .figure-sub').textContent())! };
}
const num = (detail: string, word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(detail)?.[1] ?? 0);

test('reservar, cambiar y cancelar actualizan las tarjetas en vivo y coinciden con la API', async ({ page }) => {
  test.setTimeout(120_000);
  const admin = await adminSession('admin@saludcita.test');
  const token = await patientToken('paciente17');
  await clearUpcoming(token);

  // La cita se reserva en un día con horarios; el panel se filtra por ESE día
  const ap = await bookFree(token, SERVICE.sosa, { skip: 3 });
  const day = localDate(ap.slot.starts_at);
  await cancelAppointment(token, ap.id, ap.version);                 // se parte de un estado limpio para ese día

  await page.goto(`${env.API}/panel/#/inicio`);
  await expect(page.locator('.live-status')).toContainText('En vivo');
  await pickDate(page, 'Fecha', day);
  const navigations: string[] = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

  const check = async () => {
    const d = (await admin('GET', `/admin/dashboard?date=${day}`)).json;
    await expect.poll(async () => (await kpi(page, /^Citas del/)).value, { timeout: 10_000 }).toBe(d.kpis.today_total);
    expect((await kpi(page, /^Horarios libres/)).value).toBe(d.kpis.slots_free_remaining_today);
    return d;
  };
  const d0 = await check();
  const t0 = await kpi(page, /^Citas del/);
  const free0 = (await kpi(page, /^Horarios libres/)).value;

  // 1) Reserva → +1 cita del día, −1 horario libre
  const ap2 = await bookFree(token, SERVICE.sosa, { after: new Date(Date.parse(ap.slot.starts_at) - 60_000).toISOString() });
  expect(localDate(ap2.slot.starts_at)).toBe(day);
  await expect.poll(async () => (await kpi(page, /^Citas del/)).value, { timeout: 5_000 }).toBe(t0.value + 1);
  expect((await kpi(page, /^Horarios libres/)).value).toBe(free0 - 1);
  // La hora que muestra el panel es la del horario, en hora de República Dominicana
  const hora = new Intl.DateTimeFormat('es-DO', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(new Date(ap2.slot.starts_at));
  const feed = page.locator('.dash-activity .rows li');
  await expect(feed.filter({ hasText: ap2.booking_reference }).filter({ hasText: 'Reserva' }).first()).toContainText(hora);
  await check();

  // 2) Cambio a otro horario del mismo día → la cita sigue contando, cambia la hora mostrada
  const slots = (await (await fetch(`${V1}/availability?doctor_service_id=${SERVICE.sosa}&from=${encodeURIComponent(ap2.slot.starts_at)}&to=${encodeURIComponent(new Date(Date.parse(ap2.slot.starts_at) + 12 * 3600_000).toISOString())}&limit=10`,
    { headers: { authorization: `Bearer ${token}` } })).json()).items.filter((s: { slot_id: string; starts_at: string }) => s.slot_id !== ap2.slot.slot_id && localDate(s.starts_at) === day);
  test.skip(slots.length === 0, 'no queda otro horario libre ese día');
  const p = await (await fetch(`${V1}/action-intents`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'reschedule', appointment_id: ap2.id, expected_version: ap2.version, new_slot_id: slots[0].slot_id }) })).json();
  expect((await confirmOrder(token, p.intent_id, p.token)).status).toBe(200);
  const nueva = new Intl.DateTimeFormat('es-DO', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(new Date(slots[0].starts_at));
  await expect(feed.filter({ hasText: ap2.booking_reference }).filter({ hasText: 'Cambio' }).first()).toContainText(`→ `, { timeout: 5_000 });
  await expect(feed.filter({ hasText: ap2.booking_reference }).filter({ hasText: 'Cambio' }).first()).toContainText(nueva);
  expect((await kpi(page, /^Citas del/)).value).toBe(t0.value + 1);
  await check();

  // 3) Cancelación → vuelve al valor inicial
  const cur = (await (await fetch(`${V1}/appointments?scope=upcoming`, { headers: { authorization: `Bearer ${token}` } })).json()).items
    .find((a: { id: string }) => a.id === ap2.id);
  await cancelAppointment(token, ap2.id, cur.version);
  await expect.poll(async () => (await kpi(page, /^Citas del/)).value, { timeout: 5_000 }).toBe(t0.value);
  expect((await kpi(page, /^Horarios libres/)).value).toBe(free0);
  const d3 = await check();

  // «Reservas registradas» se cuenta por fecha de OPERACIÓN (hoy), no por la del día filtrado: se comprueba en «Hoy»
  expect(d3.kpis.operations_today).toEqual(d0.kpis.operations_today);   // el día filtrado no es hoy: sin operaciones nuevas ese día
  await page.getByRole('button', { name: 'Hoy', exact: true }).click();
  const today = (await admin('GET', '/admin/dashboard')).json;
  const ops = await kpi(page, /^Reservas registradas/);
  expect(ops.value).toBe(today.kpis.operations_today.booked);
  expect(num(ops.detail, 'cancelaciones')).toBe(today.kpis.operations_today.cancelled);
  expect(num(ops.detail, 'cambios')).toBe(today.kpis.operations_today.rescheduled);
  const ap3 = await bookFree(token, SERVICE.sosa, { skip: 5 });
  await expect.poll(async () => (await kpi(page, /^Reservas registradas/)).value, { timeout: 5_000 }).toBe(ops.value + 1);
  await cancelAppointment(token, ap3.id, ap3.version);
  await expect.poll(async () => num((await kpi(page, /^Reservas registradas/)).detail, 'cancelaciones'), { timeout: 5_000 }).toBe(num(ops.detail, 'cancelaciones') + 1);

  expect(navigations.filter((u) => !u.includes('#/inicio'))).toEqual([]);   // nada de esto recargó la página
});
