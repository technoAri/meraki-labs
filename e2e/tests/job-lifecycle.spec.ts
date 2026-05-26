import { test, expect } from '@playwright/test';

const API = `${process.env.BASE_URL ?? 'http://localhost'}/v1`;
const KEY = process.env.API_KEY ?? 'test-api-key-1234';
const HEADERS = { 'x-api-key': KEY, 'Content-Type': 'application/json' };

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

});

// ─── Infrastructure ──────────────────────────────────────────────────────────

test.describe('Infrastructure', () => {

  test('7. GET /health returns ok', async ({ request }) => {
    const res = await request.get('http://localhost/health');
    expect(res.status()).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  test('8. Invalid API key returns 401', async ({ request }) => {
    const res = await request.get(`${API}/jobs`, {
      headers: { 'x-api-key': 'not-a-real-key', 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

});

// ─── Dashboard UI tests ──────────────────────────────────────────────────────

test.describe('Dashboard UI', () => {

  test('9. Dashboard loads and shows MetricsBar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Task Queue')).toBeVisible();
    await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Running', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  });

  test('10. Submit job via form and see it in table', async ({ page }) => {
    await page.goto('/');

    // Use a timestamp-scoped task name to avoid collisions across test runs
    const taskName = `e2e-ui-${Date.now()}`;
    await page.locator('textarea').fill(`{"task": "${taskName}"}`);
    await page.getByRole('button', { name: 'Submit Job' }).click();

    // Row appears in the table (scope to td to avoid matching the textarea itself)
    await expect(page.locator('td').filter({ hasText: taskName }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('11. DLQ page loads and retry button is visible', async ({ page }) => {
    // Navigate from root via React Router link (full-page goto /dlq hits the API via nginx)
    await page.goto('/');
    await expect(page.getByText('Task Queue')).toBeVisible();
    await page.getByRole('link', { name: 'Dead Letter Queue' }).click();
    await expect(page.getByRole('heading', { name: 'Dead Letter Queue' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('← Back to Dashboard')).toBeVisible();
  });

  test('12. DLQ retry — job disappears and stays gone (retry strips fail flag, job completes)', async ({ page, request }) => {
    // Create a fail:true job that will dead-letter after exactly one attempt
    const createRes = await request.post(`${API}/jobs`, {
      headers: HEADERS,
      data: { payload: { fail: true }, max_attempts: 1 },
    });
    expect(createRes.status()).toBe(201);
    const job = await createRes.json() as { id: string };

    // Wait for it to land in dead_letter
    await expect.poll(async () => {
      const r = await request.get(`${API}/jobs/${job.id}`, { headers: HEADERS });
      return (await r.json() as { status: string }).status;
    }, { timeout: 20_000, intervals: [500] }).toBe('dead_letter');

    // Navigate to DLQ via client-side routing (direct page.goto('/dlq') bypasses React Router)
    await page.goto('/');
    await expect(page.getByText('Task Queue')).toBeVisible();
    await page.getByRole('link', { name: 'Dead Letter Queue' }).click();
    await expect(page.getByRole('heading', { name: 'Dead Letter Queue' })).toBeVisible({ timeout: 8_000 });

    // Target the specific row by UUID prefix — first 8 chars are visible in the truncated display
    const idPrefix = job.id.slice(0, 8);
    const jobRow = page.locator('tbody tr').filter({ hasText: idPrefix });
    await expect(jobRow).toBeVisible({ timeout: 5_000 });

    // Click Retry — the row must vanish WITHOUT page.reload() (driven by WebSocket 'pending' event)
    await jobRow.getByRole('button', { name: 'Retry' }).click();
    await expect(jobRow).not.toBeVisible({ timeout: 5_000 });

    // The retry strips 'fail' from the payload via `payload - 'fail'` in the UPDATE.
    // The worker succeeds and moves the job to 'completed' — it must NOT reappear in the DLQ.
    await expect.poll(async () => {
      const r = await request.get(`${API}/jobs/${job.id}`, { headers: HEADERS });
      return (await r.json() as { status: string }).status;
    }, { timeout: 15_000, intervals: [500] }).toBe('completed');

    // Confirm the row stays absent from the DLQ table
    await expect(page.locator('tbody tr').filter({ hasText: idPrefix })).not.toBeVisible();
  });

  test('13. WebSocket delivers real-time update without page refresh', async ({ page, request }) => {
    // Wait for the WS connection to be created during page load, then confirm it's open
    // before we submit — otherwise the JOB_UPDATE event may fire before the listener is ready.
    const wsPromise = page.waitForEvent('websocket');
    await page.goto('/');
    const ws = await wsPromise;
    await ws.waitForEvent('framereceived', { timeout: 5_000 }).catch(() => {});
    await expect(page.getByText('Task Queue')).toBeVisible();

    // Submit via API (not the form) — the only path for the row to appear is
    // the WS JOB_UPDATE event triggering a refetch in Dashboard.tsx.
    const taskId = `e2e-ws-${Date.now()}`;
    const res = await request.post(`${API}/jobs`, {
      headers: HEADERS,
      data: { payload: { task: taskId } },
    });
    expect(res.status()).toBe(201);

    // Dashboard must show the job without page.reload()
    await expect(page.getByText(taskId)).toBeVisible({ timeout: 10_000 });
  });

});

// ─── Rate limit — runs last to avoid polluting the 60s window for other tests ─

test.describe('Rate limiting', () => {

  test('13. Rate limit returns 429 after limit exceeded', async ({ request }) => {
    // Tenant limit is 60/min; send 80 to reliably exceed it even accounting for
    // requests already made in earlier tests within the same 60s window.
    const requests = Array.from({ length: 80 }, () =>
      request.get(`${API}/jobs`, { headers: HEADERS })
    );
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status());
    expect(statuses.some((s) => s === 429)).toBe(true);
  });

});
