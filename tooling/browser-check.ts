import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const demo = { email: 'owner@dispatch.test', password: 'Dispatch-demo-2026!' };
const args = process.argv.slice(2);
const smokeOnly = args.length === 1 && args[0] === '--smoke-only';
if (!smokeOnly) {
  // Each test owns its server and private state through Playwright fixtures.
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  process.exit(code ?? 1);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ui-check-'));
const listener = net.createServer();
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const binary = path.resolve('.build/services/rust/dispatch-backend');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DISPATCH_PROVIDER_MODE: 'fixture',
  DISPATCH_STANDALONE: '1',
  DISPATCH_ENVIRONMENT: 'preview',
  DISPATCH_DEV_MAIL_MODE: 'capture',
  DISPATCH_STATE_ROOT: root,
  DISPATCH_ORIGIN: origin,
  DISPATCH_ARTIFACT_ROOT: path.resolve('.build'),
  PORT: String(port),
};
execFileSync(binary, ['seed'], { env, stdio: 'inherit' });
const server = spawn(binary, ['serve'], { env, stdio: 'inherit' });
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

  const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
  const request = async (url: string, payload?: unknown) => {
    const response = await fetch(origin + url, {
      method: payload === undefined ? 'GET' : 'POST',
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
    return response;
  };
  const manifest = JSON.parse(fs.readFileSync('.build/release.json', 'utf8'));
  const health = await (await request('/api/health')).json();
  assert.equal(health.release, manifest.digest);
  assert.equal(health.status, 'ready');
  assert.equal(health.environment, 'preview');
  const html = await (await request('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\.?\/assets\/[^"]+)"/g)];
  assert(assets.length >= 2, 'The dashboard must include its JavaScript and stylesheet');
  for (const asset of assets) await request(new URL(asset[1]!, origin).pathname);
  const login = await request('/api/auth/login', demo);
  headers.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const session = await (await request('/api/session')).json();
  assert.equal(session.user.email, demo.email);
  headers['x-csrf-token'] = session.csrf;
  const dsp = session.dsps.find((value: { name: string }) => value.name === 'Northline Logistics');
  assert(dsp, 'The fixture DSP must be available');
  const view = await (await request('/api/session/dsp', { dspId: dsp.id })).json();
  headers['x-dispatch-view'] = view.token;
  const settings = await (await request('/api/dsp/paycom/settings')).json();
  assert(settings.options.departments.length > 0);
  process.stdout.write(
    'Built Dev smoke check passed: health, assets, login, DSP access and Paycom settings.\n',
  );
} finally {
  if (server.exitCode === null) {
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve());
      server.kill('SIGTERM');
    });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
