// Host verification uses the Rust sandbox launcher and the built browser runtime.
import { execFileSync } from 'node:child_process';
execFileSync('cargo', ['test', '--locked', '--test', 'host', '--', '--nocapture'], {
  stdio: 'inherit',
  env: { ...process.env, DISPATCH_TEST_HOST: '1', DISPATCH_WORKER_NODE: process.execPath },
});
