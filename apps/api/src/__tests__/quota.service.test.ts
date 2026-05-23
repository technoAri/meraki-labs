import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../db/client.js', () => ({ sql: mockSql }));

describe('quota.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tenant IDs that are under their concurrency limit', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
    const { getEligibleTenantIds } = await import('../services/quota.service.js');
    const result = await getEligibleTenantIds();
    expect(result).toEqual(['tenant-1', 'tenant-2']);
  });

  it('excludes tenant at concurrency limit (returns empty)', async () => {
    mockSql.mockResolvedValueOnce([]);
    const { getEligibleTenantIds } = await import('../services/quota.service.js');
    const result = await getEligibleTenantIds();
    expect(result).toHaveLength(0);
  });

  it('returns only uncapped tenants when mix exists', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'tenant-available' }]);
    const { getEligibleTenantIds } = await import('../services/quota.service.js');
    const result = await getEligibleTenantIds();
    expect(result).toEqual(['tenant-available']);
    expect(result).not.toContain('tenant-at-limit');
  });
});
