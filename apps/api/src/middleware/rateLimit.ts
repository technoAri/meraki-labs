import type { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../cache/redis.js';

const WINDOW_MS = 60_000;
const WINDOW_SECONDS = 60;

export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { tenant } = request;
  const now = Date.now();
  const key = `ratelimit:${tenant.id}`;

  try {
    const member = `${now}-${Math.random().toString(36).slice(2)}`;
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, now - WINDOW_MS);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.expire(key, WINDOW_SECONDS + 1);
    const results = await pipeline.exec();

    const count = (results?.[2]?.[1] as number) ?? 0;

    if (count > tenant.rate_limit_per_minute) {
      // Undo the slot we just consumed — rejected requests don't count against the window
      await redis.zrem(key, member);
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestMs = oldest[1] ? Number(oldest[1]) : now;
      const retryAfter = Math.max(1, Math.ceil((oldestMs + WINDOW_MS - now) / 1000));
      reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({ error: 'Rate limit exceeded', retryAfter });
    }
  } catch {
    // Redis unavailable — fail open to avoid blocking all requests
  }
}
