import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { env } from '../helpers';

// Contrato de estilos: la hoja assets/wa.css depende de unos pocos selectores internos de Gradio 6.30.0
// (documentados en wa.css y docs/decisiones-implementacion.md). Si Gradio cambia su estructura, esta prueba falla.
const EVID = '../../docs/evidencias/correccion';

async function demo(page: Page, user = 'paciente04') {
  const r = await page.request.post(`${env.GRADIO}/acceso/demo`, { headers: { 'x-saludcita-ui': '1' }, data: { username: user, password: env.patientPassword } });
  expect(r.status()).toBe(200);
  await page.goto(`${env.GRADIO}/chat/`);
  await expect(page.locator('.sc-wa-meta').getByText('cuenta de demostración')).toBeVisible();
}
const bg = (page: Page, sel: string) => page.locator(sel).last().evaluate((e) => getComputedStyle(e).backgroundColor);

// Una cuenta ficticia por prueba: el login de pacientes tiene límite por cuenta y no se comparte entre pruebas
test('estructura interna de Gradio y estilos de burbujas, listas, pestañas y cabecera', async ({ page }) => {
  await demo(page, 'paciente04');
  await page.getByRole('button', { name: 'Reservar cita', exact: true }).click();
  await page.getByRole('button', { name: 'Cardiología', exact: true }).click();
  await expect(page.getByRole('button', { name: /^1 · / })).toBeVisible();
  expect(await bg(page, '#sc-chat .message-row.bot-row .message.bot')).toBe('rgb(255, 255, 255)');
  expect(await bg(page, '#sc-chat .message-row.user-row .message.user')).toBe('rgb(235, 228, 254)')   // violeta suave compartido con el panel;
  const before = await page.locator('#sc-chat .message ol > li').first().evaluate((li) => getComputedStyle(li, '::before').content);
  expect(before).toContain('counter');
  const liBox = await page.locator('#sc-chat .message ol > li').first().boundingBox();
  const bubble = await page.locator('#sc-chat .message.bot').last().boundingBox();
  expect(liBox!.x).toBeGreaterThanOrEqual(bubble!.x); // el número queda dentro de la burbuja
  await expect(page.locator('#sc-tabs [role=tab]')).toHaveCount(3);
  expect(await page.locator('.sc-wa-head .sc-ico').first().evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  await expect(page.locator('#sc-chat .avatar-container img').first()).toBeVisible();
});

for (const [name, viewport] of [['escritorio', { width: 1100, height: 900 }], ['movil-teclado', { width: 390, height: 520 }]] as const) {
  test(`borde del campo completo y redondeado mientras se espera la respuesta (${name})`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, locale: 'es-DO', extraHTTPHeaders: { 'x-forwarded-for': process.env.E2E_RUN_IP ?? '198.18.0.9' } });
    const page = await ctx.newPage();
    await demo(page, name === 'escritorio' ? 'paciente05' : 'paciente07');
    // cita de un mensaje + botones de respuesta rápida visibles
    await page.getByRole('button', { name: 'Reservar cita', exact: true }).click();
    await expect(page.getByText('¿Para qué especialidad?').last()).toBeVisible();
    await page.locator('#sc-chat .message.bot').last().click();
    await expect(page.locator('.sc-quote-box')).toBeVisible();
    const input = page.locator('#sc-input textarea');
    await input.fill('Hola, quería saber cómo funciona esto, porque tengo varias dudas sobre las citas de mi familia y no sé por dónde empezar.');
    await input.press('Enter');
    await expect(page.locator('#sc-chat .sc-typing')).toBeVisible();
    // escribiendo un mensaje largo mientras espera
    await input.fill('Segunda línea larga que el paciente escribe mientras el asistente responde, para ver el borde con varias líneas de texto.');
    const ring = await page.locator('#sc-input').evaluate((el) => {
      const cs = getComputedStyle(el);
      const w = el.querySelector(':scope > .wrap.generating');
      const ws = w ? getComputedStyle(w) : null;
      return { radius: parseFloat(cs.borderTopLeftRadius), overlay: ws ? { radius: parseFloat(ws.borderTopLeftRadius), left: ws.borderLeftWidth, top: ws.borderTopWidth,
        right: ws.borderRightWidth, bottom: ws.borderBottomWidth, display: ws.display } : null };
    });
    expect(ring.radius).toBeGreaterThanOrEqual(20);
    if (ring.overlay && ring.overlay.display !== 'none') {
      expect(ring.overlay.radius).toBeGreaterThanOrEqual(20);
      expect(new Set([ring.overlay.left, ring.overlay.top, ring.overlay.right, ring.overlay.bottom]).size).toBe(1); // los 4 lados iguales
    }
    await page.locator('.sc-wa-input').screenshot({ path: `${EVID}/campo-procesando-${name}.png` });
    await expect(page.locator('#sc-chat .sc-typing')).toHaveCount(0, { timeout: 90_000 });
    await input.focus();
    await page.locator('.sc-wa-input').screenshot({ path: `${EVID}/campo-foco-${name}.png` });
    await ctx.close();
  });
}

test('teclado, preferencias de sonido y movimiento reducido', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', locale: 'es-DO', extraHTTPHeaders: { 'x-forwarded-for': process.env.E2E_RUN_IP ?? '198.18.0.9' } });
  const page = await ctx.newPage();
  await demo(page, 'paciente09');
  // Sonido por tecla: desactivado por defecto y preferencia independiente
  await page.locator('.sc-wa-kebab-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sc-keysound')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sc-wa-sound')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sc-wa.kebab-open')).toHaveCount(0);
  await expect(page.locator('.sc-wa-kebab-btn')).toBeFocused();
  // Del campo de texto al botón enviar con Tab
  await page.locator('#sc-input textarea').focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}#${a.id}.${a.className}` : ''; });
  expect(focused, `foco tras Tab: ${focused}`).toMatch(/sc-send|sc-wa-send/);
  // Movimiento reducido: solo fundido
  const anim = await page.locator('#sc-chat .message-row').first().evaluate((e) => getComputedStyle(e).animationName);
  expect(anim).toBe('sc-fade');
  // La mascota no bloquea controles
  expect(await page.locator('.sc-wa-avatar').evaluate((e) => getComputedStyle(e).pointerEvents === 'none' || !e.closest('button'))).toBe(true);
  await ctx.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accesibilidad automática (axe, WCAG 2 A/AA) de la ventana de chat · tema ${scheme}`, async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: scheme, locale: 'es-DO', extraHTTPHeaders: { 'x-forwarded-for': process.env.E2E_RUN_IP ?? '198.18.0.9' } });
    const page = await ctx.newPage();
    await demo(page, scheme === 'light' ? 'paciente12' : 'paciente15');
    await expect(page.locator('#sc-chat .bubble-wrap')).toHaveAttribute('tabindex', '0'); // la conversación se desplaza con el teclado
    const res = await new AxeBuilder({ page }).include('.sc-wa').withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, serious.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join(' | ')}`).join('\n')).toHaveLength(0);
    await ctx.close();
  });
}
