const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser', testMatch: ['independent-updates.spec.cjs', 'update-progress.spec.cjs', 'updates-workspace.spec.cjs', 'dashboard-rollout.spec.cjs'],
  workers: 1, timeout: 60000,
  outputDir: process.env.DISPATCH_UI_ARTIFACTS || '/tmp/dispatch-updates-browser',
  use: { viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    launchOptions: process.env.DISPATCH_CHROME_EXECUTABLE ? { executablePath: process.env.DISPATCH_CHROME_EXECUTABLE } : {} },
});
