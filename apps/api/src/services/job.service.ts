import { trace } from '@opentelemetry/api';
import type { Job, JobStatus, Json } from '@task-queue/shared';
import { sql } from '../db/client.js';
import { jobsSubmittedTotal, jobsPendingGauge } from '../metrics/prometheus.js';
import { broadcast } from '../ws/websocket.js';

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
        const existing = await sql<Job[]>`
          SELECT * FROM jobs
          WHERE tenant_id = ${input.tenantId}
            AND idempotency_key = ${input.idempotencyKey!}
          LIMIT 1
        `;
        return existing[0];
      }

      const job = rows[0];
      jobsSubmittedTotal.inc({ tenant_id: input.tenantId });
      jobsPendingGauge.inc({ tenant_id: input.tenantId });
      return job;
    } finally {
      span.end();
    }
  });
}

export async function getJob(jobId: string, tenantId: string): Promise<Job | null> {
  const rows = await sql<Job[]>`
    SELECT * FROM jobs WHERE id = ${jobId} AND tenant_id = ${tenantId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listJobs(
  tenantId: string,
  status?: JobStatus
): Promise<Job[]> {
  if (status) {
    return sql<Job[]>`
      SELECT * FROM jobs
      WHERE tenant_id = ${tenantId} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT 100
    `;
  }
  return sql<Job[]>`
    SELECT * FROM jobs
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 100
  `;
}

export interface JobCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
}

export async function getJobCounts(tenantId: string): Promise<JobCounts> {
  const rows = await sql<{ status: string; count: number }[]>`
    SELECT status, COUNT(*)::int AS count
    FROM jobs
    WHERE tenant_id = ${tenantId}
    GROUP BY status
  `;
  const result: JobCounts = { pending: 0, running: 0, completed: 0, failed: 0, dead_letter: 0 };
  for (const row of rows) {
    const key = row.status as keyof JobCounts;
    if (key in result) result[key] = row.count;
  }
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
    broadcast({ type: 'JOB_UPDATE', data: { id: rows[0].id, tenant_id: tenantId, status: 'failed', updated_at: rows[0].updated_at } });
  }
  return rows[0] ?? null;
}
