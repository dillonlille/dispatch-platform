import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  retries: 0,
  reporter: 'list',
  outputDir: process.env.DISPATCH_TEST_OUTPUT || '/tmp/dispatch-browser-test-results',
  use: {
    baseURL: process.env.DISPATCH_TEST_URL || 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    // Default device matches the seeded DSP; timezone regressions override this.
    timezoneId: 'America/Chicago',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
