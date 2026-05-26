import type { FastifyInstance } from 'fastify';
import type { Job } from '@task-queue/shared';
import { sql, readWithFallback } from '../db/client.js';
import { broadcast } from '../ws/websocket.js';
import { jobsPendingGauge } from '../metrics/prometheus.js';
import { invalidateCounts } from '../cache/countsCache.js';

export async function dlqRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dlq', async (request) => {
    return readWithFallback((db) => db<Job[]>`
      SELECT * FROM jobs
      WHERE tenant_id = ${request.tenant.id} AND status = 'dead_letter'
      ORDER BY updated_at DESC
      LIMIT 100
    `);
  });

  app.post<{ Params: { id: string } }>('/dlq/:id/retry', async (request, reply) => {
    const rows = await sql<Job[]>`
      UPDATE jobs
      SET
        status           = 'pending',
        attempts         = 0,
        error            = NULL,
        lease_expires_at = NULL,
        worker_id        = NULL,
        scheduled_at     = NOW(),
        updated_at       = NOW()
      WHERE id = ${request.params.id}
        AND tenant_id = ${request.tenant.id}
        AND status = 'dead_letter'
      RETURNING *
    `;

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Dead letter job not found' });
    }

    const job = rows[0];
    jobsPendingGauge.inc({ tenant_id: request.tenant.id });
    void invalidateCounts(request.tenant.id);
    broadcast({ type: 'JOB_UPDATE', data: { id: job.id, tenant_id: job.tenant_id, status: 'pending', updated_at: job.updated_at } });
    return job;
  });
}
