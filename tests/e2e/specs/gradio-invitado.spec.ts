import { type Browser, expect, type Page, test } from '@playwright/test';
import { RUN_HEADERS, appointment, cancelAppointment, env, myAppointments } from '../helpers';

// Acceso sin registro previo, transparente: sesión de dispositivo (cookie HttpOnly) y recuperación dentro del chat
// con el código de recuperación + fecha de nacimiento. El código nunca se envía a la conversación (ni a n8n ni al modelo).
const chat = (page: Page) => page.getByRole('log');
const CODE_RE = /SCR(?:-[A-Z0-9]{5}){5}/;
const input = (page: Page) => page.locator('.sc-wa-text textarea');

async function deviceToken(page: Page) {
  const c = (await page.context().cookies(env.GRADIO)).find((x) => x.name === 'sc_device');
  expect(c, 'cookie de sesión del dispositivo').toBeTruthy();
  return c!;
}

async function freshVisitor(browser: Browser) {
  const ctx = await browser.newContext({ locale: 'es-DO', timezoneId: 'America/Santo_Domingo', extraHTTPHeaders: RUN_HEADERS });
  const page = await ctx.newPage();
  await page.goto(`${env.GRADIO}/chat/`);
  await expect(page.getByText('Visitante').first()).toBeVisible();
  return { ctx, page };
}

async function write(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press('Enter');
}

test('un visitante reserva sin registrarse, recibe su código y lo recupera en otro dispositivo desde el chat', async ({ browser }) => {
  const a = await freshVisitor(browser);
  const cookie = await deviceToken(a.page);
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  expect(await a.page.evaluate(() => document.cookie)).not.toContain('sc_device');
  const token = cookie.value;
  await expect(a.page.getByRole('tab', { name: 'Tu acceso' })).toHaveCount(0); // el acceso es transparente

  // Reserva por el menú guiado: nombre y fecha de nacimiento (calendario) en la tarjeta de confirmación
  await a.page.getByRole('button', { name: 'Reservar cita', exact: true }).click();
  await a.page.getByRole('button', { name: 'Pediatría', exact: true }).click();
  await a.page.getByRole('button', { name: /^1 · / }).click();
  await expect(a.page.getByText('Confirma tu cita')).toBeVisible();
  await a.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(a.page.getByText('Escribe tu nombre, tu fecha de nacimiento y un teléfono o correo')).toBeVisible();
  expect(await myAppointments(token, 'upcoming')).toHaveLength(0);
  await a.page.getByLabel('Tu nombre y apellido').fill('Visitante Prueba Ficticia');
  await a.page.locator('#sc-birth input').fill('1990-05-17');
  await a.page.getByLabel('Teléfono o correo').fill('(809) 555-0177');
  await a.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  const done = chat(a.page).getByText(/quedó confirmada para el/);
  await expect(done).toHaveCount(1);
  const ref = (await done.textContent())!.match(/SC-[A-Z2-9]{6}/)![0];
  expect((await myAppointments(token, 'upcoming')).map((x) => x.booking_reference)).toEqual([ref]);
  // Primera reserva: el chat entrega el código de recuperación una sola vez
  await expect(chat(a.page).getByText(CODE_RE)).toBeVisible();
  const code = (await chat(a.page).getByText(CODE_RE).textContent())!.match(CODE_RE)![0];

  // Recarga: misma sesión y conversación; el código ya no se vuelve a mostrar
  await a.page.reload();
  await expect(chat(a.page).getByText(ref).first()).toBeVisible();
  await expect(chat(a.page).getByText(CODE_RE)).toHaveCount(0);
  expect((await deviceToken(a.page)).value).toBe(token);

  // Otro visitante no ve nada del primero
  const b = await freshVisitor(browser);
  expect((await deviceToken(b.page)).value).not.toBe(token);
  await b.page.getByRole('tab', { name: 'Mis citas' }).click();
  await expect(b.page.getByText('No tienes citas')).toBeVisible();
  await b.page.getByRole('tab', { name: 'Chat' }).click();

  // Recuperación en el chat: el código se oculta en la burbuja y se pide la fecha de nacimiento
  await write(b.page, code);
  await expect(chat(b.page).getByText('Código de recuperación ••••••')).toBeVisible();
  await expect(chat(b.page).getByText(code)).toHaveCount(0);
  await expect(chat(b.page).getByText('dime tu fecha de nacimiento')).toBeVisible();
  await write(b.page, '17/05/1990');
  await expect(chat(b.page).getByText('ya recuperaste tus citas')).toBeVisible();
  await expect(chat(b.page).getByText(ref).first()).toBeVisible();
  const rotated = (await chat(b.page).getByText(CODE_RE).textContent())!.match(CODE_RE)![0];
  expect(rotated).not.toBe(code);
  // La cookie del segundo dispositivo quedó fijada (nonce de un solo uso): tras recargar sigue siendo el mismo paciente
  await expect.poll(async () => (await deviceToken(b.page)).value).not.toBe('');
  await b.page.reload();
  await expect(b.page.getByText('Visitante Prueba Ficticia')).toBeVisible();

  // El código usado ya no sirve, aunque la fecha sea correcta
  const c = await freshVisitor(browser);
  await write(c.page, code);
  await expect(chat(c.page).getByText('dime tu fecha de nacimiento')).toBeVisible();
  await write(c.page, '17/05/1990');
  // Acceso denegado: código ya usado (o, si se repite la prueba muchas veces, el límite de 5 intentos cada 15 min por IP)
  await expect(chat(c.page).getByText(/No pude verificar el código|Demasiados intentos/)).toBeVisible();
  await expect(chat(c.page).getByText('ya recuperaste tus citas')).toHaveCount(0);

  // El código nunca llegó a la conversación (ni a n8n ni al modelo)
  const hist = await (await fetch(`${env.API}/api/v1/conversation?limit=100`, { headers: { authorization: `Bearer ${token}` } })).json();
  expect(JSON.stringify(hist)).not.toContain(code.slice(4));

  const ap = (await myAppointments(token, 'upcoming'))[0];
  await cancelAppointment(token, ap.id, ap.version);
  expect((await appointment(token, ap.id)).status).toBe('cancelled');
  await Promise.all([a.ctx.close(), b.ctx.close(), c.ctx.close()]);
});

test('responder a un mensaje: tocarlo lo cita sobre la barra de escritura y se puede cancelar', async ({ browser }) => {
  const v = await freshVisitor(browser);
  await v.page.getByRole('button', { name: 'Reservar cita', exact: true }).click();
  await expect(chat(v.page).getByText('¿Para qué especialidad?')).toBeVisible();
  await chat(v.page).getByText('¿Para qué especialidad?').click();
  await expect(v.page.locator('.sc-quote-box')).toContainText('¿Para qué especialidad?');
  await v.page.getByRole('button', { name: 'Cancelar respuesta' }).click();
  await expect(v.page.locator('.sc-quote-box')).toHaveCount(0);
  await v.ctx.close();
});

test('las rutas de acceso rechazan peticiones sin la cabecera propia, de otro origen o con un nonce inválido', async ({ request }) => {
  expect((await request.post(`${env.GRADIO}/acceso/recuperar`, { data: { code: 'SCR-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' } })).status()).toBe(403);
  expect((await request.post(`${env.GRADIO}/acceso/salir`, { headers: { 'x-saludcita-ui': '1', origin: 'https://otro-sitio.example' } })).status()).toBe(403);
  expect((await request.post(`${env.GRADIO}/acceso/activar`, { headers: { 'x-saludcita-ui': '1' }, data: { nonce: 'inventado' } })).status()).toBe(400);
});
