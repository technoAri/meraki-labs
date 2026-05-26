import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Tenant } from '@task-queue/shared';
import { getTenantByApiKey } from '../cache/tenantCache.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    reply.code(401).send({ error: 'Missing x-api-key header' });
    return;
  }

  const tenant = await getTenantByApiKey(apiKey);

  if (!tenant) {
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }

  request.tenant = tenant;
}
