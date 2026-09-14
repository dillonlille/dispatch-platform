import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture } from './helpers.js';
import { writeManifest, verifyArtifact } from '../services/releases/artifact.js';
import { backupState, restoreState } from '../services/storage/backup.js';
import { acquireLock } from '../services/storage/lock.js';
import { Storage } from '../services/storage/index.js';
import { configuration } from '../services/config.js';
import { createApp } from '../api/app.js';
import { token } from '../shared/crypto.js';
function artifact(root: string, version: string) {
  fs.mkdirSync(root, { mode: 0o700 });
  for (const dir of ['api', 'dashboard']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'api/main.js'), `// ${version}\n`);
  fs.writeFileSync(path.join(root, 'dashboard/index.html'), '<title>Dispatch</title>');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'dispatch-platform', version, type: 'module' }),
  );
  return writeManifest(root, version);
}
test('immutable artifacts require tested current Preview before promotion; activation preserves private state and rolls back code', async (t) => {
  const f = await fixture({ allowDeployment: true });
  t.after(() => f.close());
  const owner = await f.client();
  const source = path.join(f.root, 'candidate'),
    manifest = artifact(source, '1.0.0');
  const digest = f.releases.register(source);
  assert.equal(digest, manifest.digest);
  assert.throws(() => f.releases.request(digest, 'production', owner.session.user.id));
  const request = f.releases.request(digest, 'preview', owner.session.user.id);
  f.runtime.storage.platform.run(
    "UPDATE deployment_requests SET status='running' WHERE id=?",
    request.id,
  );
  const installed = f.releases.installFiles(digest, 'preview');
  assert.equal(verifyArtifact(installed.target).digest, digest);
  f.releases.complete(request.id);
  f.releases.markTested(digest, owner.session.user.id);
  const privateSentinel = path.join(f.root, 'dsps', 'sentinel');
  fs.writeFileSync(privateSentinel, 'DSP data', { mode: 0o600 });
  const archive = path.join(f.root, 'archive');
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, 'retained'), 'archive');
  const prod = f.releases.request(digest, 'production', owner.session.user.id);
  f.runtime.storage.platform.run(
    "UPDATE deployment_requests SET status='running' WHERE id=?",
    prod.id,
  );
  const activation = f.releases.installFiles(digest, 'production');
  f.releases.complete(prod.id);
  assert.equal(fs.readFileSync(privateSentinel, 'utf8'), 'DSP data');
  assert(fs.existsSync(path.join(archive, 'retained')));
  assert.equal(f.releases.list()[0]!.production, true);
  f.releases.rollbackFiles(activation.backup);
  assert.equal(fs.existsSync(path.join(f.root, 'api/main.js')), false);
  assert.equal(fs.readFileSync(privateSentinel, 'utf8'), 'DSP data');
  fs.appendFileSync(path.join(source, 'api/main.js'), 'tamper');
  assert.throws(() => verifyArtifact(source));
});
test('development deployment switch is off and symlinked artifacts are rejected', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.client(),
    source = path.join(f.root, 'candidate');
  artifact(source, '1.0.0');
  const digest = f.releases.register(source);
  assert.throws(() => f.releases.request(digest, 'preview', c.session.user.id));
  fs.symlinkSync('/etc/passwd', path.join(source, 'api', 'link'));
  assert.throws(() => verifyArtifact(source));
  assert.equal(
    (await c.post(`/api/platform/releases/${digest}/deploy`, { environment: 'preview' }))
      .statusCode,
    409,
  );
});
test('offline backup is consistent, checksummed, and restores with sessions revoked', async (t) => {
  const f = await fixture();
  const c = await f.client();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backup-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const unlock = acquireLock(f.runtime.storage.paths.environment('production'), 'api');
  await assert.rejects(backupState(f.root, path.join(parent, 'blocked')));
  assert.throws(() => acquireLock(f.runtime.storage.paths.environment('production'), 'api'));
  unlock();
  const originalRoot = f.root;
  await f.app.close();
  try {
    const backup = path.join(parent, 'backup');
    await backupState(originalRoot, backup);
    const restored = path.join(parent, 'restored');
    restoreState(backup, restored);
    const storage = new Storage(configuration({ stateRoot: restored }));
    assert.equal(storage.platform.one<{ n: number }>('SELECT count(*) n FROM users')!.n, 2);
    assert.equal(storage.platform.one<{ n: number }>('SELECT count(*) n FROM sessions')!.n, 0);
    storage.close();
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'backup.json'), 'utf8'));
    fs.appendFileSync(path.join(backup, manifest.files[0].path), 'changed');
    assert.throws(() => restoreState(backup, path.join(parent, 'tampered')));
  } finally {
    fs.rmSync(originalRoot, { recursive: true, force: true });
  }
});
test('separate Preview receives Dev requests through gateway; production DSPs and direct access are rejected', async (t) => {
  const f = await fixture();
  const key = token();
  const dashboardRoot = path.join(f.root, 'test-dashboard');
  fs.mkdirSync(path.join(dashboardRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dashboardRoot, 'index.html'), '<h1>Candidate dashboard</h1>');
  fs.writeFileSync(path.join(dashboardRoot, 'assets', 'test.js'), 'window.candidate=true;');
  const candidate = await createApp(
    configuration({
      stateRoot: f.root,
      environment: 'preview',
      development: true,
      providerMode: 'fixture',
      origin: 'http://127.0.0.1:5173',
      port: 0,
      previewKey: key,
      release: 'candidate-release',
    }),
    { dashboardRoot },
  );
  const address = await candidate.app.listen({ host: '127.0.0.1', port: 0 });
  const gateway = await createApp(
    configuration({
      stateRoot: f.root,
      origin: 'http://127.0.0.1:5173',
      previewOrigin: address,
      previewKey: key,
      release: 'production-release',
    }),
  );
  t.after(async () => {
    await gateway.app.close();
    await candidate.app.close();
    await f.close();
  });
  const c = await f.client(),
    dev = c.session.dsps.find((d) => d.permanent)!,
    north = c.session.dsps.find((d) => d.name === 'Northline Logistics')!;
  await c.select(dev.id);
  const previewPage = await gateway.app.inject({ url: '/preview/', headers: c.headers });
  assert.equal(previewPage.statusCode, 200, previewPage.body);
  assert(previewPage.body.includes('Candidate dashboard'));
  const previewAsset = await gateway.app.inject({
    url: '/preview/assets/test.js',
    headers: c.headers,
  });
  assert.equal(previewAsset.statusCode, 200, previewAsset.body);
  assert(previewAsset.body.includes('window.candidate'));
  const routed = await gateway.app.inject({ url: '/api/dsp/overview', headers: c.headers });
  assert.equal(routed.statusCode, 200, routed.body);
  assert.equal(routed.json().dsp.id, dev.id);
  const queued = await gateway.app.inject({
    method: 'POST',
    url: '/api/dsp/jobs',
    headers: c.headers,
    payload: { requestId: 'candidate-only' },
  });
  assert.equal(queued.statusCode, 202, queued.body);
  assert.equal(queued.json().release, 'candidate-release');
  assert.throws(() => gateway.runtime.runner.queue.get(queued.json().id));
  assert.equal(
    (await candidate.app.inject({ url: '/api/dsp/overview', headers: c.headers })).statusCode,
    403,
  );
  await c.select(north.id);
  const prod = await gateway.app.inject({
    method: 'POST',
    url: '/api/dsp/jobs',
    headers: c.headers,
    payload: { requestId: 'production-only' },
  });
  assert.equal(prod.statusCode, 202, prod.body);
  assert.equal(prod.json().release, 'production-release');
});
