import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchSandbox } from '../services/browsers/sandbox.js';
import { configuration } from '../services/config.js';

// Checks the actual host without visiting a provider or using credentials.
fs.mkdirSync('.runtime', { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.resolve('.runtime/browser-preflight-'));
try {
  const bundle = path.join(root, 'services/runtime');
  fs.mkdirSync(path.join(bundle, 'node_modules'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.resolve('.build/node_modules'), path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(bundle, 'auth-worker.js'),
    `
    import { chromium } from 'playwright';
    const context = await chromium.launchPersistentContext('/profile', {
      executablePath: process.argv[2], headless: true, chromiumSandbox: true,
      args: ['--disable-dev-shm-usage'],
    });
    const page = await context.newPage();
    await page.goto('chrome://sandbox');
    console.log(await page.locator('body').innerText());
    await context.close();
  `,
  );
  for (const name of ['profile', 'run']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const child = launchSandbox(
    configuration({ runtimeBundle: bundle }),
    path.join(root, 'profile'),
    path.join(root, 'run'),
  );
  child.stdin.end();
  let output = '',
    diagnostics = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, diagnostics);
    assert.match(output, /Layer 1 Sandbox\s+Namespace/);
    assert.match(output, /PID namespaces\s+Yes/);
    assert.match(output, /Network namespaces\s+Yes/);
    assert.match(output, /Seccomp-BPF sandbox\s+Yes/);
    process.stdout.write(
      'Browser host verified: Chromium namespace and seccomp sandboxes are active inside the private worker.\n',
    );
  } finally {
    clearTimeout(timer);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
