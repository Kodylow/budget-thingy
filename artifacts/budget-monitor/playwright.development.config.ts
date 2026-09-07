import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'development-view.spec.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'NODE_ENV=development PORT=4175 BASE_PATH=/ pnpm run dev',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});