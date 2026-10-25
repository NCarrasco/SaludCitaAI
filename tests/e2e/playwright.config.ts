import { defineConfig, devices } from '@playwright/test';
import { RUN_HEADERS, RUN_IP, env } from './helpers';

// Misma IP de documentación en el proceso principal y en los workers (heredan el entorno)
process.env.E2E_RUN_IP ??= RUN_IP;

// Requiere el sistema levantado (README §1). No arranca servicios por sí mismo.
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  use: { extraHTTPHeaders: RUN_HEADERS, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'es-DO', timezoneId: 'America/Santo_Domingo' },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'movil', use: { ...devices['Pixel 7'] }, testMatch: /permisos|reserva|panel-informacion|panel-capturas/ },
  ],
  metadata: { api: env.API, gradio: env.GRADIO },
});
