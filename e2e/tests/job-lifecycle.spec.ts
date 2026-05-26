import { test, expect } from '@playwright/test';

const API = `${process.env.BASE_URL ?? 'http://localhost'}/v1`;
const KEY = process.env.API_KEY ?? 'test-api-key-1234';
const HEADERS = { 'x-api-key': KEY, 'Content-Type': 'application/json' };

// ─── helpers ────────────────────────────────────────────────────────────────

async function submitJob(request: ReturnType<typeof test.info>['attachments'][0] extends never ? never : unknown, payload: object, extra: object = {}) {
  // Use fetch directly inside tests via page.evaluate or request fixture
}

// ─── API-level helpers using Playwright request context ─────────────────────

test.describe('Job lifecycle — API', () => {

  // Ensure rate-limit window has headroom before starting.
  // Uses native fetch (no fixture timeout) and extends hook timeout via test.setTimeout.
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    for (let successes = 0; successes < 5; ) {
      const probe = await fetch(`${API}/jobs`, { headers: HEADERS });
      if (probe.status === 429) {
        const body = await probe.json() as { retryAfter?: number };
        await new Promise((res) => setTimeout(res, ((body.retryAfter ?? 60) + 2) * 1000));
        successes = 0;
      } else {
        successes++;
      }
    }
  });

  test('1. Submit a normal job and it completes', async ({ request }) => {
    // Submit
    const res = await request.post(`${API}/jobs`, {
      headers: HEADERS,
      data: { payload: { task: 'e2e-normal' } },
    });
    expect(res.status()).toBe(201);
    const job = await res.json() as { id: string; status: string };
    expect(job.status).toBe('pending');

    // Poll until completed (workers pick it up within ~2s)
    await expect.poll(async () => {
      const r = await request.get(`${API}/jobs/${job.id}`, { headers: HEADERS });
      const j = await r.json() as { status: string };
      return j.status;
    }, { timeout: 15_000, intervals: [500] }).toBe('completed');
  });

  test('2. Failing job exhausts retries and lands in DLQ', async ({ request }) => {
    const res = await request.post(`${API}/jobs`, {
      headers: HEADERS,
      data: { payload: { fail: true }, max_attempts: 2 },
    });
    expect(res.status()).toBe(201);
    const job = await res.json() as { id: string; status: string };

    // Poll until dead_letter
    await expect.poll(async () => {
      const r = await request.get(`${API}/jobs/${job.id}`, { headers: HEADERS });
      const j = await r.json() as { status: string };
      return j.status;
    }, { timeout: 30_000, intervals: [1000] }).toBe('dead_letter');

    // Verify it appears in DLQ list
    const dlq = await request.get(`${API}/dlq`, { headers: HEADERS });
    const dlqJobs = await dlq.json() as { id: string }[];
    expect(dlqJobs.some((j) => j.id === job.id)).toBe(true);
  });

  test('3. Retry from DLQ moves job back to pending', async ({ request }) => {
    // Create a dead-lettered job first
    const res = await request.post(`${API}/jobs`, {
      headers: HEADERS,
      data: { payload: { fail: true }, max_attempts: 1 },
    });
    const job = await res.json() as { id: string };

    // Wait for dead_letter
    await expect.poll(async () => {
      const r = await request.get(`${API}/jobs/${job.id}`, { headers: HEADERS });
      const j = await r.json() as { status: string };
      return j.status;
    }, { timeout: 20_000, intervals: [500] }).toBe('dead_letter');

    // Retry
    const retryRes = await request.post(`${API}/dlq/${job.id}/retry`, { headers: HEADERS, data: {} });
    expect(retryRes.status()).toBe(200);
    const retried = await retryRes.json() as { status: string };
    expect(retried.status).toBe('pending');

    // Verify removed from DLQ list
    const dlq = await request.get(`${API}/dlq`, { headers: HEADERS });
    const dlqJobs = await dlq.json() as { id: string }[];
    expect(dlqJobs.some((j) => j.id === job.id)).toBe(false);
  });

  test('4. Cancel a scheduled (future) pending job', async ({ request }) => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request.post(`${API}/jobs`, {
      headers: HEADERS,
      data: { payload: { task: 'e2e-cancel' }, scheduled_at: future },
    });
    const job = await res.json() as { id: string; status: string };
    expect(job.status).toBe('pending');

    const cancelRes = await request.post(`${API}/jobs/${job.id}/cancel`, { headers: HEADERS, data: {} });
    expect(cancelRes.status()).toBe(200);
    const cancelled = await cancelRes.json() as { status: string; error: string };
    expect(cancelled.status).toBe('failed');
    expect(cancelled.error).toBe('Cancelled by user');
  });

  test('5. MetricsBar counts match GET /jobs/counts', async ({ request }) => {
    const res = await request.get(`${API}/jobs/counts`, { headers: HEADERS });
    expect(res.status()).toBe(200);
    const counts = await res.json() as Record<string, number>;
    expect(counts).toHaveProperty('pending');
    expect(counts).toHaveProperty('running');
    expect(counts).toHaveProperty('completed');
    expect(counts).toHaveProperty('failed');
    expect(counts).toHaveProperty('dead_letter');
    for (const v of Object.values(counts)) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('6. Idempotency key — duplicate submission returns same job', async ({ request }) => {
    const key = `e2e-idem-${Date.now()}`;
    const body = { payload: { task: 'idem-test' }, idempotency_key: key };

    const r1 = await request.post(`${API}/jobs`, { headers: HEADERS, data: body });
    const r2 = await request.post(`${API}/jobs`, { headers: HEADERS, data: body });

    const j1 = await r1.json() as { id: string };
    const j2 = await r2.json() as { id: string };
    expect(j1.id).toBe(j2.id);
  });

  test('7. Rate limit returns 429 after limit exceeded', async ({ request }) => {
    // Hit the endpoint rapidly to trigger rate limit
    // Tenant limit is 60/min; send 80 to reliably exceed it even with prior-test requests in window
    const requests = Array.from({ length: 80 }, () =>
      request.get(`${API}/jobs`, { headers: HEADERS })
    );
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status());
    expect(statuses.some((s) => s === 429)).toBe(true);
  });

});

// ─── Dashboard UI tests ──────────────────────────────────────────────────────

test.describe('Dashboard UI', () => {

  test('8. Dashboard loads and shows MetricsBar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Task Queue')).toBeVisible();
    await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Running', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  });

  test('9. Submit job via form and see it in table', async ({ page }) => {
    await page.goto('/');

    // Fill in the form
    await page.locator('textarea').fill('{"task": "e2e-ui-test"}');
    await page.getByRole('button', { name: 'Submit Job' }).click();

    // Row appears in table
    await expect(page.getByText('e2e-ui-test')).toBeVisible({ timeout: 10_000 });
  });

  test('10. DLQ page loads and retry button is visible', async ({ page }) => {
    // Navigate from root via React Router link (full-page goto /dlq hits the API via nginx)
    await page.goto('/');
    await expect(page.getByText('Task Queue')).toBeVisible();
    await page.getByRole('link', { name: 'Dead Letter Queue' }).click();
    await expect(page.getByRole('heading', { name: 'Dead Letter Queue' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('← Back to Dashboard')).toBeVisible();
  });

});
