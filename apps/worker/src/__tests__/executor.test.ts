import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from '@task-queue/shared';

const mockSql = vi.fn();
vi.mock('../db.js', () => ({ sql: mockSql }));

const mockStartLeaseHeartbeat = vi.fn();
vi.mock('../leaser.js', () => ({ startLeaseHeartbeat: mockStartLeaseHeartbeat }));

const mockMetrics = {
  jobsCompletedTotal: { inc: vi.fn() },
  jobsFailedTotal: { inc: vi.fn() },
  jobsDeadLetteredTotal: { inc: vi.fn() },
  jobsPendingGauge: { inc: vi.fn(), dec: vi.fn() },
  jobsRunningGauge: { inc: vi.fn(), dec: vi.fn() },
  jobProcessingDurationMs: { observe: vi.fn() },
};
vi.mock('../metrics.js', () => mockMetrics);

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_n: string, fn: (s: { end: () => void; setAttribute: () => void }) => unknown) =>
        fn({ end: vi.fn(), setAttribute: vi.fn() }),
    }),
  },
}));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    tenant_id: 'tenant-1',
    idempotency_key: null,
    payload: {},
    status: 'running',
    priority: 0,
    attempts: 1,
    max_attempts: 3,
    lease_expires_at: null,
    worker_id: 'worker-1',
    scheduled_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('executor', () => {
  let heartbeat: ReturnType<typeof setInterval>;

  beforeEach(() => {
    vi.clearAllMocks();
    heartbeat = setInterval(() => {}, 100_000);
    mockStartLeaseHeartbeat.mockReturnValue(heartbeat);
  });

  afterEach(() => {
    clearInterval(heartbeat);
  });

  it('acks job as completed on success', async () => {
    const updatedAt = new Date().toISOString();
    mockSql
      .mockResolvedValueOnce([{ updated_at: updatedAt }]) // UPDATE completed RETURNING
      .mockResolvedValueOnce([]);                          // pg_notify

    const { executeJob } = await import('../executor.js');
    await executeJob(makeJob({ payload: {} }), 'worker-1');

    expect(mockMetrics.jobsCompletedTotal.inc).toHaveBeenCalledWith({ tenant_id: 'tenant-1' });
    expect(mockMetrics.jobsRunningGauge.dec).toHaveBeenCalled();
    expect(mockMetrics.jobProcessingDurationMs.observe).toHaveBeenCalled();
  }, 2_000);

  it('nacks as pending when attempts < max_attempts', async () => {
    const updatedAt = new Date().toISOString();
    mockSql
      .mockResolvedValueOnce([{ status: 'pending', updated_at: updatedAt }]) // UPDATE nack RETURNING
      .mockResolvedValueOnce([]);                                              // pg_notify

    const { executeJob } = await import('../executor.js');
    await executeJob(makeJob({ payload: { fail: true }, attempts: 1, max_attempts: 3 }), 'worker-1');

    expect(mockMetrics.jobsFailedTotal.inc).toHaveBeenCalledWith({ tenant_id: 'tenant-1' });
    expect(mockMetrics.jobsDeadLetteredTotal.inc).not.toHaveBeenCalled();
    expect(mockMetrics.jobsRunningGauge.dec).toHaveBeenCalled();
  }, 2_000);

  it('nacks as dead_letter and increments DLQ counter when attempts exhausted', async () => {
    const updatedAt = new Date().toISOString();
    mockSql
      .mockResolvedValueOnce([{ status: 'dead_letter', updated_at: updatedAt }]) // UPDATE nack RETURNING
      .mockResolvedValueOnce([]);                                                  // pg_notify

    const { executeJob } = await import('../executor.js');
    await executeJob(makeJob({ payload: { fail: true }, attempts: 3, max_attempts: 3 }), 'worker-1');

    expect(mockMetrics.jobsFailedTotal.inc).toHaveBeenCalledWith({ tenant_id: 'tenant-1' });
    expect(mockMetrics.jobsDeadLetteredTotal.inc).toHaveBeenCalledWith({ tenant_id: 'tenant-1' });
  }, 2_000);
});
