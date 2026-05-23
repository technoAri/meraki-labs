import { trace } from '@opentelemetry/api';
import type { Job } from '@task-queue/shared';
import { sql } from './db.js';

const tracer = trace.getTracer('worker.claimer');

export async function claimJob(workerId: string, eligibleTenantIds: string[]): Promise<Job | null> {
  if (eligibleTenantIds.length === 0) return null;

  return tracer.startActiveSpan('job.claim', async (span) => {
    try {
      const rows = await sql<Job[]>`
        UPDATE jobs
        SET
          status           = 'running',
          lease_expires_at = NOW() + INTERVAL '30 seconds',
          worker_id        = ${workerId},
          started_at       = NOW(),
          attempts         = attempts + 1,
          updated_at       = NOW()
        WHERE id = (
          SELECT j.id
          FROM jobs j
          WHERE j.status = 'pending'
            AND j.scheduled_at <= NOW()
            AND j.tenant_id = ANY(${sql.array(eligibleTenantIds)}::uuid[])
          ORDER BY j.priority DESC, j.scheduled_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `;
      const job = rows[0] ?? null;
      if (job) {
        await sql`SELECT pg_notify('job_status_change', ${JSON.stringify({ id: job.id, tenant_id: job.tenant_id, status: 'running', updated_at: job.updated_at })})`;
      }
      return job;
    } finally {
      span.end();
    }
  });
}
