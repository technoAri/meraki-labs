import { trace } from '@opentelemetry/api';
import type { Job } from '@task-queue/shared';
import { sql } from './db.js';
import { startLeaseHeartbeat } from './leaser.js';
import {
  jobsCompletedTotal,
  jobsFailedTotal,
  jobsDeadLetteredTotal,
  jobsPendingGauge,
  jobsRunningGauge,
  jobProcessingDurationMs,
} from './metrics.js';

const tracer = trace.getTracer('worker.executor');
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL_SECONDS ?? 10);

async function notify(id: string, tenantId: string, status: string, updatedAt: string): Promise<void> {
  await sql`SELECT pg_notify('job_status_change', ${JSON.stringify({ id, tenant_id: tenantId, status, updated_at: updatedAt })})`;
}

async function simulateWork(job: Job): Promise<void> {
  const delay = 100 + Math.random() * 400;
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (job.payload['fail'] === true) throw new Error('Simulated job failure');
}

export async function executeJob(job: Job, workerId: string): Promise<void> {
  const startTime = Date.now();
  jobsRunningGauge.inc({ tenant_id: job.tenant_id });
  jobsPendingGauge.dec({ tenant_id: job.tenant_id });

  let stolen = false;
  const heartbeat = startLeaseHeartbeat(job.id, workerId, HEARTBEAT_INTERVAL, () => {
    stolen = true;
  });

  return tracer.startActiveSpan('job.execute', async (span) => {
    try {
      await simulateWork(job);

      if (stolen) {
        span.end();
        return;
      }

      clearInterval(heartbeat);

      await tracer.startActiveSpan('job.ack', async (ackSpan) => {
        try {
          const acked = await sql<{ updated_at: string }[]>`
            UPDATE jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW()
            WHERE id = ${job.id} AND worker_id = ${workerId}
            RETURNING updated_at
          `;
          jobsCompletedTotal.inc({ tenant_id: job.tenant_id });
          jobsRunningGauge.dec({ tenant_id: job.tenant_id });
          jobProcessingDurationMs.observe({ tenant_id: job.tenant_id }, Date.now() - startTime);
          if (acked[0]) await notify(job.id, job.tenant_id, 'completed', acked[0].updated_at);
        } finally {
          ackSpan.end();
        }
      });
    } catch (err) {
      if (!stolen) {
        clearInterval(heartbeat);
      }

      const error = err instanceof Error ? err.message : String(err);

      await tracer.startActiveSpan('job.nack', async (nackSpan) => {
        try {
          const rows = await sql<{ status: string; updated_at: string }[]>`
            UPDATE jobs
            SET
              status    = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
              worker_id = CASE WHEN attempts >= max_attempts THEN worker_id ELSE NULL END,
              lease_expires_at = CASE WHEN attempts >= max_attempts THEN lease_expires_at ELSE NULL END,
              error     = ${error},
              updated_at = NOW()
            WHERE id = ${job.id} AND worker_id = ${workerId}
            RETURNING status, updated_at
          `;

          jobsRunningGauge.dec({ tenant_id: job.tenant_id });
          jobsFailedTotal.inc({ tenant_id: job.tenant_id });

          if (rows[0]) {
            await notify(job.id, job.tenant_id, rows[0].status, rows[0].updated_at);
          }

          if (rows[0]?.status === 'dead_letter') {
            jobsDeadLetteredTotal.inc({ tenant_id: job.tenant_id });
            nackSpan.setAttribute('job.dlq', true);
            await tracer.startActiveSpan('job.dlq', async (dlqSpan) => {
              dlqSpan.end();
            });
          }
        } finally {
          nackSpan.end();
        }
      });
    } finally {
      span.end();
    }
  });
}
