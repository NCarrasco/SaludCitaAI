import { request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { env } from './helpers';

// Un inicio de sesión por rol y ejecución: el login del panel tiene límite de 10 intentos / 5 min por correo.
export default async function globalSetup() {
  mkdirSync('.auth', { recursive: true });
  for (const [role, email] of [['viewer', 'panel@saludcita.test'], ['admin', 'admin@saludcita.test']] as const) {
    const ctx = await request.newContext({ baseURL: env.API });
    const r = await ctx.post('/api/v1/auth/login', { data: { email, password: env.adminPassword } });
    if (!r.ok()) throw new Error(`login ${email}: ${r.status()} (¿límite de intentos? espera 5 minutos)`);
    await ctx.storageState({ path: `.auth/${role}.json` });
    await ctx.dispose();
  }
}
