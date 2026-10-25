import type { Pool, PoolClient } from '../../db/pool.js';

export async function getPatientView(q: Pick<Pool | PoolClient, 'query'>, patientId: string) {
  const r = await q.query('SELECT id, full_name, birth_date, phone, email, kind FROM patients WHERE id = $1', [patientId]);
  const p = r.rows[0];
  if (!p) return undefined;
  return { id: p.id as string, full_name: p.full_name as string | null, birth_date: p.birth_date as string | null,
           phone: p.phone as string | null, email: p.email as string | null,
           profile_complete: Boolean(p.full_name && p.birth_date && (p.phone || p.email)), kind: p.kind as 'account' | 'guest' };
}
