import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { built, demo, fixture } from './fixture-server.js';
const args = process.argv.slice(2);
const smokeOnly = args.length === 1 && args[0] === '--smoke-only';
if (!smokeOnly) {
  execFileSync('cargo', ['build', '--locked', '--example', 'assessment-fixture'], {
    stdio: 'inherit',
  });
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
// The smoke check serves the built artifact exactly as it will be published.
const app = await fixture({ ...built, output: 'inherit' });
try {
  const page = async (url: string) => {
    const response = await app.raw(url);
    assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
    return response;
  };
  const manifest = JSON.parse(fs.readFileSync('.build/release.json', 'utf8'));
  const health = await (await page('/api/health')).json();
  assert.equal(health.release, manifest.digest);
  assert.equal(health.status, 'ready');
  assert.equal(health.environment, 'preview');
  const html = await (await page('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\.?\/assets\/[^"]+)"/g)];
  assert(assets.length >= 2, 'The dashboard must include its JavaScript and stylesheet');
  for (const asset of assets) await page(new URL(asset[1]!, app.env.DISPATCH_ORIGIN).pathname);
  // `client` fails unless the login and, below, the DSP view both return 200.
  const owner = await app.client();
  assert.equal(owner.session.user.email, demo.email);
  const dsp = owner.session.dsps.find(
    (value: { name: string }) => value.name === 'Northline Logistics',
  );
  assert(dsp, 'The fixture DSP must be available');
  await owner.select(dsp.id);
  const settings = await owner.get('/api/dsp/paycom/settings');
  assert.equal(settings.status, 200, settings.body);
  assert(settings.value.options.departments.length > 0);
  process.stdout.write(
    'Built Dev smoke check passed: health, assets, login, DSP access and Paycom settings.\n',
  );
} finally {
  await app.close();
}
