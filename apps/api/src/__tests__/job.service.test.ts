import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '@task-queue/shared';

const mockSql = Object.assign(vi.fn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((v: unknown) => v),
});
vi.mock('../db/client.js', () => ({
  sql: mockSql,
  readWithFallback: (queryFn: (db: typeof mockSql) => unknown) => queryFn(mockSql),
}));
vi.mock('../cache/countsCache.js', () => ({ invalidateCounts: vi.fn() }));
vi.mock('../metrics/prometheus.js', () => ({
  jobsSubmittedTotal: { inc: vi.fn() },
  jobsPendingGauge: { inc: vi.fn(), dec: vi.fn() },
}));
vi.mock('../ws/websocket.js', () => ({ broadcast: vi.fn() }));
vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: (_n: string, fn: (s: { end: () => void }) => unknown) => fn({ end: vi.fn() }) }) },
}));

const baseJob: Job = {
  id: 'job-1',
  tenant_id: 'tenant-1',
  idempotency_key: 'key-abc',
  payload: { task: 'test' },
  status: 'pending',
  priority: 0,
  attempts: 0,
  max_attempts: 3,
  lease_expires_at: null,
  worker_id: null,
  scheduled_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
  error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('job.service idempotency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns existing job on idempotency key collision', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([baseJob]);

    const { submitJob } = await import('../services/job.service.js');
    const result = await submitJob({
      tenantId: 'tenant-1',
      payload: { task: 'test' },
      idempotencyKey: 'key-abc',
    });

    expect(result.id).toBe('job-1');
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns newly created job when no collision', async () => {
    mockSql.mockResolvedValueOnce([baseJob]);

    const { submitJob } = await import('../services/job.service.js');
    const result = await submitJob({
      tenantId: 'tenant-1',
      payload: { task: 'new' },
    });

    expect(result.id).toBe('job-1');
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

describe('job.service cancelJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when job is not in pending state', async () => {
    mockSql.mockResolvedValueOnce([]); // UPDATE WHERE status='pending' matches nothing

    const { cancelJob } = await import('../services/job.service.js');
    const result = await cancelJob('job-running', 'tenant-1');

    expect(result).toBeNull();
  });

  it('returns updated job with failed status when cancelled from pending', async () => {
    const cancelled = { ...baseJob, status: 'failed' as const, error: 'Cancelled by user' };
    mockSql.mockResolvedValueOnce([cancelled]);

    const { cancelJob } = await import('../services/job.service.js');
    const result = await cancelJob('job-1', 'tenant-1');

    expect(result?.status).toBe('failed');
    expect(result?.error).toBe('Cancelled by user');
  });
});
