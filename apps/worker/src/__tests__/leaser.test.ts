import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../db.js', () => ({ sql: mockSql }));
vi.mock('../metrics.js', () => ({ workerLeaseRenewalsTotal: { inc: vi.fn() } }));
vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: (_n: string, fn: (s: { end: () => void }) => unknown) => fn({ end: vi.fn() }) }) },
}));

describe('leaser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when lease renewed', async () => {
    mockSql.mockResolvedValueOnce({ count: 1 });
    const { renewLease } = await import('../leaser.js');
    const ok = await renewLease('job-1', 'worker-1');
    expect(ok).toBe(true);
  });

  it('returns false when job stolen (0 rows updated)', async () => {
    mockSql.mockResolvedValueOnce({ count: 0 });
    const { renewLease } = await import('../leaser.js');
    const ok = await renewLease('job-1', 'worker-1');
    expect(ok).toBe(false);
  });
});
