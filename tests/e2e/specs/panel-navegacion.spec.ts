import { expect, type Page, test } from '@playwright/test';
import { SERVICE, bookFree, clearUpcoming, env, patientToken } from '../helpers';

// Navegación por tareas: rutas antiguas redirigen, cada subsección tiene enlace propio, los indicadores abren listas
// filtradas y los filtros del periodo se conservan al cambiar de pestaña.
test.use({ storageState: '.auth/admin.json' });
const TZ = 'America/Santo_Domingo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const hash = (page: Page) => page.evaluate(() => location.hash);
const sub = (page: Page) => page.locator('.subnav a[aria-current="page"]');
/** El panel de filtros de Citas está plegado por defecto: se abre antes de mirar sus opciones */
async function openFilters(page: Page) {
  const b = page.getByRole('button', { name: /Mostrar filtros/ });
  if (await b.isVisible()) await b.click();
}

test('rutas antiguas redirigen a la nueva estructura', async ({ page }) => {
  for (const [old, now, h1, tab] of [
    ['resumen', '#/estadisticas/actividad', 'Estadísticas', 'Actividad'], ['ocupacion', '#/estadisticas/ocupacion', 'Estadísticas', 'Ocupación'],
    ['ofertas', '#/estadisticas/adelantos', 'Estadísticas', 'Adelantos'], ['traspasos', '#/ayuda', 'Solicitudes de ayuda', null],
    ['mantenimiento', '#/configuracion/profesionales', 'Configuración', 'Profesionales'], ['sistema', '#/sistema', 'Sistema', 'Integraciones'],
  ] as const) {
    await page.goto(`${env.API}/panel/#/${old}`);
    await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
    expect(await hash(page)).toBe(now);
    if (tab) await expect(sub(page)).toHaveText(tab);
  }
});

test('enlaces profundos a subsecciones y conservación del periodo entre pestañas', async ({ page }) => {
  await page.goto(`${env.API}/panel/#/sistema/asistente`);
  await expect(sub(page)).toHaveText('Diagnóstico del asistente');
  await expect(page.getByText('Evaluaciones del modelo (históricas')).toBeVisible();
  await page.goto(`${env.API}/panel/#/estadisticas/actividad`);
  const filters = page.getByRole('form', { name: 'Periodo y filtros' });
  await filters.getByRole('button', { name: 'Últimos 7 días' }).click();
  await page.getByRole('link', { name: 'Ocupación', exact: true }).click();
  await expect(sub(page)).toHaveText('Ocupación');
  await expect(filters.getByRole('button', { name: 'Últimos 7 días' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: 'Adelantos', exact: true }).click();
  await expect(page.getByText('Recuperación de horarios liberados')).toBeVisible();
  await expect(page.getByText('Uso del asistente')).toHaveCount(0);   // diagnóstico técnico fuera de las métricas del servicio
});

test('los indicadores abren Citas con los filtros correspondientes', async ({ page }) => {
  await page.goto(`${env.API}/panel/#/inicio`);
  await page.locator('.metrics').getByRole('button', { name: /^Citas de hoy/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Citas' })).toBeVisible();
  expect(await hash(page)).toContain(`from=${today()}`);
  await openFilters(page);
  await expect(page.getByRole('button', { name: /^Desde:/ })).toHaveAttribute('data-value', today());
  await expect(page.getByRole('button', { name: /^Hasta \(incluido\):/ })).toHaveAttribute('data-value', today());

  await page.goto(`${env.API}/panel/#/inicio`);
  const pend = page.locator('.dash-attention .pend').filter({ hasText: 'citas sin asistencia registrada' });
  if (await pend.count()) {
    await pend.getByRole('button', { name: 'Registrar asistencia' }).click();
    await openFilters(page);
    await expect(page.getByRole('radio', { name: /^Reservadas/ })).toBeChecked();
  }

  await page.goto(`${env.API}/panel/#/estadisticas/actividad`);
  await page.locator('.kpi').filter({ hasText: 'Cancelaciones' }).getByRole('button', { name: 'Ver citas' }).click();
  await openFilters(page);
  await expect(page.getByRole('radio', { name: /^Canceladas/ })).toBeChecked();
});

test('Citas muestra por defecto solo las activas; las canceladas se eligen y se cuentan aparte', async ({ page }) => {
  await page.goto(`${env.API}/panel/#/citas`);
  await openFilters(page);
  await expect(page.getByRole('radio', { name: /^Activas/ })).toBeChecked();
  await expect(page.locator('table.data tbody')).not.toContainText('Cancelada');
  const canceladas = page.locator('.fs-option').filter({ hasText: /^Canceladas/ });
  await expect(canceladas.locator('.fs-count')).toHaveText(/^\d/);
  await canceladas.click();
  await expect(page.getByRole('button', { name: 'Quitar filtro Canceladas' })).toBeVisible();
  await page.getByRole('button', { name: 'Quitar filtro Canceladas' }).click();
  await expect(page.getByRole('radio', { name: /^Activas/ })).toBeChecked();
});

test('detalle de una cita con historial, también por enlace profundo', async ({ page }) => {
  const token = await patientToken('paciente18');
  await clearUpcoming(token);
  const ap = await bookFree(token, SERVICE.jimenez, { skip: 2 });
  await page.goto(`${env.API}/panel/#/citas?cita=${ap.id}`);
  const dialog = page.getByRole('dialog', { name: 'Detalle de la cita' });
  await expect(dialog).toContainText(ap.booking_reference);
  await expect(dialog.locator('.history')).toContainText('Reservada');
  await expect(dialog.locator('.history')).toContainText('por paciente');
  await page.screenshot({ path: `test-results/capturas/${test.info().project.name}-light-citas-detalle.png` });
  await dialog.getByRole('button', { name: 'Cerrar' }).last().click();
  await clearUpcoming(token);
});

test('Pendientes muestra cantidades por tipo, sin sumar entidades distintas', async ({ page }) => {
  await page.goto(`${env.API}/panel/#/inicio`);
  await expect(page.locator('.metrics')).toBeVisible();
  await expect(page.locator('.metrics')).not.toContainText('Requiere atención');
  const rows = page.locator('.dash-attention .pend');
  for (const r of await rows.all()) {
    await expect(r.locator('.pend-n')).toHaveText(/^\d[\d.,]*$/);
    await expect(r.locator('.pend-text strong')).toHaveText(/citas|solicitudes|confirmaciones|trabajos|comprobantes/);
  }
});
