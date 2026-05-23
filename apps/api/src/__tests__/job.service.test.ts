import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '@task-queue/shared';

const mockSql = Object.assign(vi.fn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((v: unknown) => v),
});
vi.mock('../db/client.js', () => ({ sql: mockSql }));
vi.mock('../metrics/prometheus.js', () => ({
  jobsSubmittedTotal: { inc: vi.fn() },
  jobsPendingGauge: { inc: vi.fn() },
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
