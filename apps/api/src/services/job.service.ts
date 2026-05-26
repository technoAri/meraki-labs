import { trace } from '@opentelemetry/api';
import type { Job, JobStatus, Json } from '@task-queue/shared';
import { sql, readWithFallback } from '../db/client.js';
import { jobsSubmittedTotal, jobsPendingGauge } from '../metrics/prometheus.js';
import { broadcast } from '../ws/websocket.js';
import { getCachedCounts, setCachedCounts, invalidateCounts, type CachedCounts } from '../cache/countsCache.js';

const tracer = trace.getTracer('job.service');

export interface SubmitJobInput {
  tenantId: string;
  payload: { [key: string]: Json };
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  scheduledAt?: Date;
}

export async function submitJob(input: SubmitJobInput): Promise<Job> {
  return tracer.startActiveSpan('job.submit', async (span) => {
    try {
      const rows = await sql<Job[]>`
        INSERT INTO jobs (tenant_id, idempotency_key, payload, priority, max_attempts, scheduled_at)
        VALUES (
          ${input.tenantId},
          ${input.idempotencyKey ?? null},
          ${sql.json(input.payload)},
          ${input.priority ?? 0},
          ${input.maxAttempts ?? 3},
          ${input.scheduledAt ?? new Date()}
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING *
      `;

      if (rows.length === 0) {
        const existing = await readWithFallback((db) => db<Job[]>`
          SELECT * FROM jobs
          WHERE tenant_id = ${input.tenantId}
            AND idempotency_key = ${input.idempotencyKey!}
          LIMIT 1
        `);
        return existing[0];
      }

      const job = rows[0];
      jobsSubmittedTotal.inc({ tenant_id: input.tenantId });
      jobsPendingGauge.inc({ tenant_id: input.tenantId });
      void invalidateCounts(input.tenantId);
      return job;
    } finally {
      span.end();
    }
  });
}

export async function getJob(jobId: string, tenantId: string): Promise<Job | null> {
  const rows = await readWithFallback((db) => db<Job[]>`
    SELECT * FROM jobs WHERE id = ${jobId} AND tenant_id = ${tenantId} LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function listJobs(tenantId: string, status?: JobStatus): Promise<Job[]> {
  if (status) {
    return readWithFallback((db) => db<Job[]>`
      SELECT * FROM jobs
      WHERE tenant_id = ${tenantId} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT 100
    `);
  }
  return readWithFallback((db) => db<Job[]>`
    SELECT * FROM jobs
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 100
  `);
}

export type JobCounts = CachedCounts;

export async function getJobCounts(tenantId: string): Promise<JobCounts> {
  const cached = await getCachedCounts(tenantId);
  if (cached) return cached;

  const rows = await readWithFallback((db) => db<{ status: string; count: number }[]>`
    SELECT status, COUNT(*)::int AS count
    FROM jobs
    WHERE tenant_id = ${tenantId}
    GROUP BY status
  `);

  const result: JobCounts = { pending: 0, running: 0, completed: 0, failed: 0, dead_letter: 0 };
  for (const row of rows) {
    const k = row.status as keyof JobCounts;
    if (k in result) result[k] = row.count;
  }

  void setCachedCounts(tenantId, result);
  return result;
}

export async function cancelJob(jobId: string, tenantId: string): Promise<Job | null> {
  const rows = await sql<Job[]>`
    UPDATE jobs
    SET status = 'failed', error = 'Cancelled by user', updated_at = NOW()
    WHERE id = ${jobId} AND tenant_id = ${tenantId} AND status = 'pending'
    RETURNING *
  `;
  if (rows.length > 0) {
    jobsPendingGauge.dec({ tenant_id: tenantId });
    void invalidateCounts(tenantId);
    broadcast({ type: 'JOB_UPDATE', data: { id: rows[0].id, tenant_id: tenantId, status: 'failed', updated_at: rows[0].updated_at } });
  }
  return rows[0] ?? null;
}
