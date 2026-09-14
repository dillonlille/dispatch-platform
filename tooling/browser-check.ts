import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../services/runtime.js';
import { configuration } from '../services/config.js';
import { seed } from './seed.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ui-check-'));
const runtime = new Runtime(
  configuration({ stateRoot: root, development: true, providerMode: 'fixture' }),
);
await seed(runtime);
await runtime.close();
const port = 5190,
  origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['.build/api/main.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    DISPATCH_PROVIDER_MODE: 'fixture',
    DISPATCH_FIXTURE_PREVIEW: '1',
    DISPATCH_STATE_ROOT: root,
    DISPATCH_ORIGIN: origin,
    PORT: String(port),
  },
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Built API failed to start');
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
    stdio: 'inherit',
    env: { ...process.env, DISPATCH_TEST_URL: origin },
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  if (server.exitCode === null) {
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve());
      server.kill('SIGTERM');
    });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
