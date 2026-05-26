import { redis } from './redis.js';
import { sql } from '../db/client.js';
import type { Tenant } from '@task-queue/shared';

const TTL_SECONDS = 300;

export async function getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
  const key = `tenant:apikey:${apiKey}`;

  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as Tenant;
  } catch {
    // Redis unavailable — fall through to DB
  }

  const rows = await sql<Tenant[]>`
    SELECT * FROM tenants WHERE api_key = ${apiKey} LIMIT 1
  `;

  if (rows.length === 0) return null;

  try {
    await redis.setex(key, TTL_SECONDS, JSON.stringify(rows[0]));
  } catch {
    // Cache write failure is non-fatal
  }

  return rows[0];
}
