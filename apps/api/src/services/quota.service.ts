import { sql } from '../db/client.js';

export async function getEligibleTenantIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT t.id
    FROM tenants t
    WHERE (
      SELECT COUNT(*) FROM jobs j
      WHERE j.tenant_id = t.id AND j.status = 'running'
    ) < t.max_concurrent_jobs
  `;
  return rows.map((r) => r.id);
}
