import fs from 'node:fs';
// Only known output owned by this repository's verification commands.
for (const file of [
  '/tmp/dispatch-browser-test-results',
  '/tmp/dispatch-dashboard-desktop.png',
  '/tmp/dispatch-dashboard-mobile.png',
  '/tmp/dispatch-verification-desktop.png',
  '/tmp/dispatch-verification-mobile.png',
  '/tmp/dispatch-native-failure.png',
])
  fs.rmSync(file, { recursive: true, force: true });
