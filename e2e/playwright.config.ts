import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost',
    extraHTTPHeaders: {
      'x-api-key': process.env.API_KEY ?? 'test-api-key-1234',
    },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
