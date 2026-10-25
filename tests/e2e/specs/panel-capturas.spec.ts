import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { env } from '../helpers';

// Revisión visual del panel: capturas completas (claro/oscuro, escritorio/tablet/móvil, roles, pocos y muchos registros),
// sin errores de JavaScript, sin desplazamiento horizontal de la página y axe WCAG 2.1 AA sin infracciones.
const PAGES: [string, string][] = [['inicio', 'Inicio'], ['citas', 'Citas'], ['ayuda', 'Solicitudes de ayuda'], ['estadisticas/actividad', 'Estadísticas'],
  ['estadisticas/ocupacion', 'Estadísticas'], ['estadisticas/adelantos', 'Estadísticas'], ['configuracion/profesionales', 'Configuración'],
  ['configuracion/agenda', 'Configuración'], ['configuracion/centro', 'Configuración'], ['configuracion/vista-previa', 'Configuración'],
  ['sistema/integraciones', 'Sistema'], ['sistema/trabajos', 'Sistema'], ['sistema/asistente', 'Sistema']];

async function check(page: Page, name: string) {
  await expect(page.locator('.state.loading')).toHaveCount(0, { timeout: 15_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${name}: desplazamiento horizontal`).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${name}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
  await page.screenshot({ path: `test-results/capturas/${name}.png`, fullPage: true });
}

test.describe('admin', () => {
  test.use({ storageState: '.auth/admin.json' });
  for (const scheme of ['light', 'dark'] as const) {
    test(`páginas (${scheme})`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      for (const [hash, title] of PAGES) {
        await page.goto(`${env.API}/panel/#/${hash}`);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        await check(page, `${info.project.name}-${scheme}-${hash.replace('/', '-')}`);
      }
      expect(errors).toEqual([]);
    });
  }
  test('inicio con pocos registros (filtro sin citas) y tablet', async ({ page }, info) => {
    await page.goto(`${env.API}/panel/#/inicio`);
    await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
    await page.getByRole('button', { name: 'Mañana' }).click();
    await page.getByRole('form', { name: 'Fecha y filtros de la portada' }).getByLabel('Especialidad').selectOption({ label: 'Medicina Interna' });
    await expect(page.getByText(/filtros activos/)).toBeVisible();
    await check(page, `${info.project.name}-light-inicio-filtrado`);
    await page.getByRole('button', { name: 'Restablecer filtros' }).click();
    await expect(page.getByText(/filtros? activos?/)).toHaveCount(0);
    if (info.project.name === 'escritorio') {
      await page.setViewportSize({ width: 820, height: 1180 });
      await check(page, 'tablet-light-inicio');
    }
  });
});

for (const role of ['viewer', 'operator'] as const) {
  test(`inicio como ${role}`, async ({ browser }, info) => {
    const ctx = role === 'viewer' ? await browser.newContext({ storageState: '.auth/viewer.json', ...info.project.use })
      : await browser.newContext(info.project.use);
    const page = await ctx.newPage();
    if (role === 'operator') {
      await page.goto(`${env.API}/panel/`);
      await page.getByLabel('Correo').fill('operador@saludcita.test');
      await page.getByLabel('Contraseña').fill(env.adminPassword);
      await page.getByRole('button', { name: 'Entrar' }).click();
    } else await page.goto(`${env.API}/panel/#/inicio`);
    await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
    if (role === 'viewer') await expect(page.locator('.ref')).toHaveCount(0);   // sin referencias ni pacientes
    await check(page, `${info.project.name}-light-inicio-${role}`);
    await ctx.close();
  });
}
