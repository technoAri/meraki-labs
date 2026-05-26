import type { FastifyInstance } from 'fastify';
import type { Job } from '@task-queue/shared';
import { sql, readWithFallback } from '../db/client.js';
import { broadcast } from '../ws/websocket.js';
import { jobsPendingGauge } from '../metrics/prometheus.js';
import { invalidateCounts } from '../cache/countsCache.js';

export async function dlqRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dlq', async (request) => {
    const query = request.query as { cursor?: string; limit?: string };
    const pageSize = Math.min(query.limit ? parseInt(query.limit, 10) : 50, 200);

    let decoded: { ts: string; id: string } | null = null;
    if (query.cursor) {
      try {
        decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as { ts: string; id: string };
      } catch { /* invalid cursor — treat as first page */ }
    }

    const rows = await readWithFallback((db) => {
      const cursorFilter = decoded
        ? db`AND (updated_at < ${decoded.ts}::timestamptz OR (updated_at = ${decoded.ts}::timestamptz AND id::text < ${decoded.id}))`
        : db``;
      return db<Job[]>`
        SELECT * FROM jobs
        WHERE tenant_id = ${request.tenant.id} AND status = 'dead_letter'
        ${cursorFilter}
        ORDER BY updated_at DESC, id DESC
        LIMIT ${pageSize + 1}
      `;
    });

    const hasMore = rows.length > pageSize;
    const data = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ ts: data[data.length - 1].updated_at, id: data[data.length - 1].id })).toString('base64url')
      : null;
    return { data, nextCursor };
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
        updated_at       = NOW(),
        payload          = payload - 'fail'
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
