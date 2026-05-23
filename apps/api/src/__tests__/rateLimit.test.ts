import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestLog = new Map<string, number[]>();
const WINDOW_MS = 60_000;

function slidingWindowCheck(tenantId: string, limitPerMinute: number): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let timestamps = requestLog.get(tenantId) ?? [];
  timestamps = timestamps.filter((t) => t > cutoff);
  timestamps.push(now);
  requestLog.set(tenantId, timestamps);
  return timestamps.length <= limitPerMinute;
}

describe('rateLimit sliding window', () => {
  beforeEach(() => {
    requestLog.clear();
    vi.useFakeTimers();
  });

  it('allows requests under the limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(slidingWindowCheck('tenant-1', 10)).toBe(true);
    }
  });

  it('blocks on breach', () => {
    for (let i = 0; i < 10; i++) slidingWindowCheck('tenant-2', 10);
    expect(slidingWindowCheck('tenant-2', 10)).toBe(false);
  });

  it('allows again after window expires', () => {
    for (let i = 0; i < 10; i++) slidingWindowCheck('tenant-3', 10);
    vi.advanceTimersByTime(61_000);
    expect(slidingWindowCheck('tenant-3', 10)).toBe(true);
  });

  it('isolates per tenant', () => {
    for (let i = 0; i < 10; i++) slidingWindowCheck('tenant-a', 10);
    expect(slidingWindowCheck('tenant-b', 10)).toBe(true);
  });
});
