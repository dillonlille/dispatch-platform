const { defineConfig } = require("@playwright/test");
const previewPort = Number(process.env.DISPATCH_FRONTEND_PORT || 4339);
module.exports = defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  outputDir:
    process.env.DISPATCH_UI_ARTIFACTS || "/tmp/dispatch-ui-test-results",
  use: {
    baseURL: `http://127.0.0.1:${previewPort}`,
    viewport: { width: 1536, height: 1024 },
    reducedMotion: "reduce",
    launchOptions: process.env.DISPATCH_CHROME_EXECUTABLE
      ? { executablePath: process.env.DISPATCH_CHROME_EXECUTABLE } : {},
  },
  webServer: {
    command:
      "DISPATCH_FRONTEND_FIXTURE=1 node --no-warnings examples/frontend-preview.js",
    url: `http://127.0.0.1:${previewPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
