import { expect, test } from '@playwright/test';
import { env } from '../helpers';

// Datos institucionales en el panel: lo que se edita aquí es lo que responde el asistente (vista previa real de la API)
test('admin edita la ficha del centro y la vista previa del asistente lo refleja', async ({ page }, info) => {
  await page.goto(`${env.API}/panel/`);
  await page.getByLabel('Correo').fill('admin@saludcita.test');
  await page.getByLabel('Contraseña').fill(env.adminPassword);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await page.goto(`${env.API}/panel/#/configuracion/centro`);
  await expect(page.getByRole('heading', { level: 1, name: 'Configuración' })).toBeVisible();

  // Centro (uno solo: su ficha se muestra directamente) → Editar ficha
  const row = page.locator('.facts');
  await expect(row).toContainText('(809) 555-0100');
  await page.getByRole('button', { name: 'Editar ficha' }).click();
  const dialog = page.getByRole('dialog', { name: /Ficha de Hospital Simulado/ });
  const phone = dialog.getByLabel('Teléfono');
  const original = await phone.inputValue();
  const probe = `(809) 555-01${String(Date.now()).slice(-2)}`;
  await phone.fill(probe);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText(/El asistente ya responde con estos datos/)).toBeVisible();
  await expect(row).toContainText(probe);

  // Información al paciente → Dirección y contacto
  await page.getByRole('link', { name: 'Vista previa al paciente' }).click();
  await page.getByLabel('Tema').selectOption('ubicacion_contacto');
  await expect(page.locator('.preview-bubble')).toContainText(`Teléfono: ${probe}`);
  await page.getByLabel('Tema').selectOption('precios_seguros');
  await expect(page.locator('.preview-bubble')).toContainText(/Cardiología: RD\$/);
  await page.screenshot({ path: `test-results/panel-informacion-${info.project.name}.png`, fullPage: true });

  // Restaurar el dato original
  await page.getByRole('link', { name: 'Centro', exact: true }).click();
  await page.getByRole('button', { name: 'Editar ficha' }).click();
  await dialog.getByLabel('Teléfono').fill(original);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(row).toContainText(original);
});
