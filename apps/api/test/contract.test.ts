import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPENAPI_PATH, renderOpenApi } from '../src/openapi-export.js';

describe('contrato OpenAPI', () => {
  it('contracts/openapi.yaml coincide con los esquemas de las rutas (ejecuta npm run openapi:export si falla)', async () => {
    expect(readFileSync(OPENAPI_PATH, 'utf8')).toBe(await renderOpenApi());
  });
});
