import { defineConfig } from '@playwright/test';

const runRealInfra = process.env.RUN_REAL_INFRA_E2E === '1';
const fallbackBaseUrl = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: runRealInfra ? (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173') : fallbackBaseUrl,
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: runRealInfra
    ? undefined
    : {
        command: 'pnpm --filter @ai-customer-service/web dev --host 127.0.0.1 --port 4173',
        url: fallbackBaseUrl,
        reuseExistingServer: false,
        timeout: 30_000,
        env: {
          VITE_API_BASE_URL: 'http://127.0.0.1:9/api',
          VITE_WS_BASE_URL: 'http://127.0.0.1:9',
        },
      },
});
