import { expect, test } from '@playwright/test';
import { SERVICE, appointment, bookFree, clearUpcoming, env, patientToken } from '../helpers';

test.use({ storageState: '.auth/admin.json' });

test('ausencia administrativa: muestra la cita en conflicto y NO la cancela ni la mueve', async ({ page }) => {
  const token = await patientToken('paciente09');
  await clearUpcoming(token);
  const ap = await bookFree(token, SERVICE.taveras, { skip: 3 });
  // Día local de la cita (Santo Domingo, UTC−4)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date(ap.slot.starts_at));
  const next = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date(Date.parse(ap.slot.starts_at) + 86400_000));

  await page.goto(`${env.API}/panel/#/configuracion/agenda`);
  await page.getByRole('combobox').first().selectOption(SERVICE.taveras);
  await page.getByLabel('Inicio').fill(`${day}T00:00`);
  await page.getByLabel('Fin').fill(`${next}T00:00`);
  await page.getByRole('button', { name: 'Revisar y registrar' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Impacto calculado')).toBeVisible();
  await expect(dialog.getByText(ap.booking_reference)).toBeVisible();
  await expect(dialog.getByText(/No se cancelan ni se mueven/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirmar cambio' }).click();
  await expect(page.getByText(/requieren gestión manual/)).toBeVisible();

  const after = await appointment(token, ap.id);
  expect(after.status).toBe('booked');
  expect(after.slot.slot_id).toBe(ap.slot.slot_id);
  expect(after.version).toBe(ap.version);

  // Limpieza con la misma sesión del navegador (sin otro login): retirar la ausencia creada por la prueba
  const status = await page.evaluate(async ({ svc, d }) => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('sc_csrf='))!.slice(8));
    const sched = await (await fetch(`/api/v1/admin/doctor-services/${svc}/schedule`)).json();
    const exc = sched.exceptions.find((x: { starts_at: string }) => x.starts_at.startsWith(d));
    if (!exc) return 0;
    return (await fetch(`/api/v1/admin/schedule-exceptions/${exc.id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status;
  }, { svc: SERVICE.taveras, d: day });
  expect(status).toBe(200);
});
