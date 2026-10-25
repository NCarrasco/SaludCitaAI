import { expect, test } from '@playwright/test';
import { env } from '../helpers';

const loginPanel = async (page: import('@playwright/test').Page, email: string, password = env.adminPassword) => {
  await page.goto(`${env.API}/panel/`);
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
};
const openMenuIfMobile = async (page: import('@playwright/test').Page) => {
  const toggle = page.getByRole('button', { name: 'Menú' });
  if (await toggle.isVisible()) await toggle.click();
};

test('login incorrecto muestra error y no abre sesión', async ({ page }) => {
  await loginPanel(page, 'operador@saludcita.test', 'contraseña-incorrecta');
  await expect(page.getByRole('alert')).toContainText('incorrectos');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
});

test.describe('viewer', () => {
  test.use({ storageState: '.auth/viewer.json' });
  test('solo Inicio y Estadísticas; las URL de Configuración y Sistema no dan acceso y el servidor rechaza', async ({ page }) => {
  await page.goto(`${env.API}/panel/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await openMenuIfMobile(page);
  const nav = page.getByRole('navigation', { name: 'Secciones' });
  await expect(nav.getByRole('link')).toHaveText(['Inicio', 'Estadísticas']);
  for (const hash of ['configuracion/centro', 'sistema/trabajos', 'citas', 'mantenimiento']) {
    await page.goto(`${env.API}/panel/#/${hash}`);
    await expect(page.getByRole('alert')).toContainText('no tiene acceso');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inicio');
  }
  const reads = await page.evaluate(async () => Promise.all(['/api/v1/admin/jobs', '/api/v1/admin/integrations', '/api/v1/stats/conversation?from=2026-10-01&to=2026-10-31',
    '/api/v1/admin/appointments?from=2026-10-01&to=2026-10-31'].map(async (u) => (await fetch(u)).status)));
  expect(reads).toEqual([403, 403, 403, 403]);
  // Permiso aplicado en el servidor, aunque la interfaz se manipule
  const status = await page.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('sc_csrf='))!.slice(8));
    const r = await fetch('/api/v1/admin/specialties', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ name: 'Intento no autorizado' }) });
    return r.status;
  });
  expect(status).toBe(403);
  await expect(page.getByText(/de [\d.,]+ habilitados/).first()).toBeVisible(); // datos reales con denominador
  });
});

test('operator: opera citas y ayuda, sin Configuración ni Sistema', async ({ page }) => {
  await loginPanel(page, 'operador@saludcita.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await openMenuIfMobile(page);
  await expect(page.getByRole('navigation', { name: 'Secciones' }).getByRole('link')).toHaveText(['Inicio', 'Citas', 'Solicitudes de ayuda', 'Estadísticas']);
  await page.goto(`${env.API}/panel/#/sistema/trabajos`);
  await expect(page.getByRole('alert')).toContainText('no tiene acceso');
  const reads = await page.evaluate(async () => Promise.all(['/api/v1/admin/jobs', '/api/v1/admin/integrations', '/handoffs'.replace(/^/, '/api/v1')]
    .map(async (u) => (await fetch(u)).status)));
  expect(reads).toEqual([403, 403, 200]);
});

test('admin: ve Configuración y Sistema (aparte, como técnico) y cierra sesión', async ({ page }) => {
  await loginPanel(page, 'admin@saludcita.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await openMenuIfMobile(page);
  await expect(page.getByRole('navigation', { name: 'Secciones' }).getByRole('link'))
    .toHaveText(['Inicio', 'Citas', 'Solicitudes de ayuda', 'Estadísticas', 'Configuración', 'Sistema']);
  await page.getByRole('link', { name: 'Configuración' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Configuración' })).toBeVisible();
  await openMenuIfMobile(page);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status);
  expect(me).toBe(401); // sesión revocada en el servidor
});
