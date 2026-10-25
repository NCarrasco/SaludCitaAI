import { expect, type Page, test } from '@playwright/test';
import { SERVICE, appointment, bookFree, cancelAppointment, clearUpcoming, env, myAppointments, myOffers, patientToken } from '../helpers';

/** Entra con una cuenta ficticia de demostración por la ruta del servidor de Gradio (fija la cookie HttpOnly del contexto). */
async function loginGradio(page: Page, username: string) {
  const r = await page.request.post(`${env.GRADIO}/acceso/demo`, { headers: { 'x-saludcita-ui': '1' },
    data: { username, password: env.patientPassword } });
  expect(r.status()).toBe(200);
  await page.goto(`${env.GRADIO}/chat/`);
  await expect(page.locator('.sc-wa-meta').getByText('cuenta de demostración')).toBeVisible();
}
const chat = (page: Page) => page.getByRole('log'); // contenedor accesible del chat de Gradio

test('reserva con confirmación explícita (menú guiado → horario → Confirmar)', async ({ page }) => {
  const user = 'paciente18';
  const token = await patientToken(user);
  await clearUpcoming(token);
  await loginGradio(page, user);
  await page.getByRole('button', { name: 'Reservar cita', exact: true }).click();
  await page.getByRole('button', { name: 'Pediatría', exact: true }).click();
  const first = page.getByRole('button', { name: /^1 · / });
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByText('Confirma tu cita')).toBeVisible();
  // Antes de pulsar Confirmar no existe la cita
  expect((await myAppointments(token, 'upcoming')).filter((a) => a.status === 'booked')).toHaveLength(0);
  // El historial es persistente: se espera un mensaje de confirmación NUEVO
  const confirmations = chat(page).getByText(/quedó confirmada para el/);
  const before = await confirmations.count();
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(confirmations).toHaveCount(before + 1);
  const msg = confirmations.last();
  const ref = (await msg.textContent())!.match(/SC-[A-Z2-9]{6}/)![0];
  const booked = (await myAppointments(token, 'upcoming')).filter((a) => a.status === 'booked');
  expect(booked.map((a) => a.booking_reference)).toEqual([ref]); // existe en PostgreSQL con esa referencia
  // Comprobante PDF: lo genera n8n tras confirmar (comando durable) y el propio chat lo entrega como documento
  const doc = chat(page).locator(`a.sc-doc[download="comprobante-${ref}-n1.pdf"]`);
  await expect(doc).toBeVisible({ timeout: 45_000 });
  const [inChat] = await Promise.all([page.waitForEvent('download'), doc.click()]);
  expect(inChat.suggestedFilename()).toBe(`comprobante-${ref}-n1.pdf`);
  // …y también queda disponible en «Mis citas»
  await page.getByRole('tab', { name: 'Mis citas' }).click();
  const link = page.locator('a.sc-receipt').first();
  await expect(link).toBeVisible({ timeout: 45_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(dl.suggestedFilename()).toBe(`comprobante-${ref}-n1.pdf`);
});

test('cancelación con confirmación explícita', async ({ page }) => {
  const user = 'paciente13';
  const token = await patientToken(user);
  await clearUpcoming(token);
  const ap = await bookFree(token, SERVICE.ortega);
  await loginGradio(page, user);
  await page.getByRole('button', { name: 'Cancelar cita', exact: true }).click();
  await expect(page.getByText('Confirma la cancelación')).toBeVisible();
  await expect(page.getByText(ap.booking_reference).first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(chat(page).getByText(new RegExp(`${ap.booking_reference} .*quedó cancelada`))).toHaveCount(1);
  expect((await appointment(token, ap.id)).status).toBe('cancelled');
});

test('aceptación de una oferta de adelanto desde la bandeja; la cita se mueve y se abre la cascada', async ({ page }) => {
  const a = await patientToken('paciente11');
  const b = await patientToken('paciente10');
  await clearUpcoming(a);
  await clearUpcoming(b);
  const early = await bookFree(a, SERVICE.sosa, { optIn: false });
  const later = await bookFree(b, SERVICE.sosa, { optIn: true, after: early.slot.starts_at });
  await cancelAppointment(a, early.id, early.version); // libera el horario temprano → oferta a B
  const offer = (await myOffers(b)).find((o) => o.status === 'pending' && o.appointment.id === later.id);
  expect(offer, 'debe existir una oferta pendiente para B').toBeTruthy();

  await loginGradio(page, 'paciente10');
  await page.getByRole('tab', { name: 'Avisos' }).click();
  await expect(page.getByText('Horario disponible antes:').first()).toBeVisible();
  await page.getByRole('button', { name: 'Aceptar adelanto' }).first().click();
  await expect(page.getByText(/Cita adelantada al/)).toBeVisible();
  const moved = await appointment(b, later.id);
  expect(moved.slot.slot_id).toBe(early.slot.slot_id);   // misma cita, nuevo horario
  expect(moved.booking_reference).toBe(later.booking_reference);
  expect(moved.version).toBe(2);
  expect((await myOffers(b)).find((o) => o.id === offer.id).status).toBe('accepted');
});
