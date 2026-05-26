import { redis } from './redis.js';

const TTL_SECONDS = 3;

export interface CachedCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
}

function key(tenantId: string): string {
  return `counts:${tenantId}`;
}

export async function getCachedCounts(tenantId: string): Promise<CachedCounts | null> {
  try {
    const cached = await redis.get(key(tenantId));
    return cached ? (JSON.parse(cached) as CachedCounts) : null;
  } catch {
    return null;
  }
}

export async function setCachedCounts(tenantId: string, counts: CachedCounts): Promise<void> {
  try {
    await redis.setex(key(tenantId), TTL_SECONDS, JSON.stringify(counts));
  } catch {
    // Non-fatal
  }
}

export async function invalidateCounts(tenantId: string): Promise<void> {
  try {
    await redis.del(key(tenantId));
  } catch {
    // Non-fatal
  }
}
