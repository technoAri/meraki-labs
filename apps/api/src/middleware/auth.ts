import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from '../db/client.js';
import type { Tenant } from '@task-queue/shared';

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

  const rows = await sql<Tenant[]>`
    SELECT * FROM tenants WHERE api_key = ${apiKey} LIMIT 1
  `;

  if (rows.length === 0) {
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }

  request.tenant = rows[0];
}
