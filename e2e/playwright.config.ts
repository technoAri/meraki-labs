import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost',
    // Use the high-limit E2E tenant key so Playwright's injected browser headers
    // match the key baked into the dashboard bundle. The rate-limit test overrides
    // per-request with RATE_HEADERS (test-api-key-1234).
    extraHTTPHeaders: {
      'x-api-key': process.env.E2E_API_KEY ?? 'test-e2e-key-5678',
    },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
