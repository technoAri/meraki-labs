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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(job: Job): string {
  return Buffer.from(JSON.stringify({ ts: job.created_at, id: job.id })).toString('base64url');
}

function decodeCursor(raw: string): { ts: string; id: string } | null {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString()) as { ts: string; id: string };
  } catch {
    return null;
  }
}

export interface PagedJobs {
  data: Job[];
  nextCursor: string | null;
}

export async function listJobs(
  tenantId: string,
  status?: JobStatus,
  cursor?: string,
  limit?: number,
): Promise<PagedJobs> {
  const pageSize = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const decoded = cursor ? decodeCursor(cursor) : null;

  const rows = await readWithFallback((db) => {
    const statusFilter = status ? db`AND status = ${status}` : db``;
    const cursorFilter = decoded
      ? db`AND (created_at < ${decoded.ts}::timestamptz OR (created_at = ${decoded.ts}::timestamptz AND id::text < ${decoded.id}))`
      : db``;
    return db<Job[]>`
      SELECT * FROM jobs
      WHERE tenant_id = ${tenantId}
      ${statusFilter}
      ${cursorFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize + 1}
    `;
  });

  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;
  return { data, nextCursor: hasMore ? encodeCursor(data[data.length - 1]) : null };
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
