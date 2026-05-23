import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = Object.assign(vi.fn(), {
  array: vi.fn((v: unknown) => v),
});
vi.mock('../db.js', () => ({ sql: mockSql }));
vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: (_n: string, fn: (s: { end: () => void }) => unknown) => fn({ end: vi.fn() }) }) },
}));

describe('claimer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no eligible tenant IDs', async () => {
    const { claimJob } = await import('../claimer.js');
    const result = await claimJob('worker-1', []);
    expect(result).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns null when SKIP LOCKED finds no jobs', async () => {
    mockSql.mockResolvedValueOnce([]);
    const { claimJob } = await import('../claimer.js');
    const result = await claimJob('worker-1', ['tenant-1']);
    expect(result).toBeNull();
  });

  it('returns claimed job', async () => {
    const job = { id: 'job-1', tenant_id: 'tenant-1', status: 'running', updated_at: new Date().toISOString() };
    mockSql.mockResolvedValueOnce([job]); // UPDATE ... RETURNING *
    mockSql.mockResolvedValueOnce([]);    // SELECT pg_notify(...)
    const { claimJob } = await import('../claimer.js');
    const result = await claimJob('worker-1', ['tenant-1']);
    expect(result?.id).toBe('job-1');
  });
});
