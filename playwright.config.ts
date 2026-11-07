import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'node scripts/browser-test-server.mjs',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
