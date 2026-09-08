import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'org-budget-chart-regression.spec.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  projects: [{
    name: 'production',
    metadata: { runtimeMode: 'production' },
    use: {
      baseURL: 'http://127.0.0.1:4173',
      viewport: { width: 1280, height: 900 },
      trace: 'retain-on-failure',
    },
  }],
  webServer: {
    command: 'NODE_ENV=production PORT=4173 BASE_PATH=/ pnpm run build && NODE_ENV=production PORT=4173 BASE_PATH=/ pnpm run serve',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});