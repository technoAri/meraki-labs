import type { FastifyRequest, FastifyReply } from 'fastify';

const windowMs = 60_000;
const requestLog = new Map<string, number[]>();

export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { tenant } = request;
  const now = Date.now();
  const cutoff = now - windowMs;

  let timestamps = requestLog.get(tenant.id) ?? [];
  timestamps = timestamps.filter((t) => t > cutoff);
  timestamps.push(now);
  requestLog.set(tenant.id, timestamps);

  if (timestamps.length > tenant.rate_limit_per_minute) {
    const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
    reply
      .code(429)
      .header('Retry-After', String(retryAfter))
      .send({ error: 'Rate limit exceeded', retryAfter });
  }
}
