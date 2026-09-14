import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture, until } from './helpers.js';
import { configuration } from '../services/config.js';
import { backupState, restoreState } from '../services/storage/backup.js';
import { Storage } from '../services/storage/index.js';
import { Database } from '../services/storage/database.js';
import { platformSchema } from '../services/storage/schema.js';

test('account migration preserves legacy identities using first and last name columns', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-name-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'accounts.sqlite');
  const legacy = new Database(filename, platformSchema.slice(0, 1));
  legacy.run(
    'INSERT INTO users(id,email,name,password,created_at) VALUES (?,?,?,?,?)',
    'usr_test',
    'test@example.invalid',
    'Jordan Ellis',
    'preserved-hash',
    '2026-09-14',
  );
  legacy.close();
  const current = new Database(filename, platformSchema);
  try {
    const row = current.one<Record<string, unknown>>('SELECT * FROM users')!;
    assert.equal(row.first_name, 'Jordan');
    assert.equal(row.last_name, 'Ellis');
    assert.equal(row.password, 'preserved-hash');
    assert.equal('name' in row, false);
  } finally {
    current.close();
  }
});

test('standalone Dev owns all accounts and DSPs, runs jobs locally, and isolates another platform', async (t) => {
  const dev = await fixture({ standalone: true, environment: 'preview' });
  const other = await fixture({ standalone: true, environment: 'production' });
  t.after(async () => {
    await dev.close();
    await other.close();
  });
  const owner = await dev.client();
  assert.equal(owner.session.user.firstName, 'Platform');
  assert.equal(owner.session.user.lastName, 'Owner');
  assert.equal('name' in owner.session.user, false);
  assert(owner.session.dsps.every((dsp) => dsp.environment === 'preview'));
  assert(fs.existsSync(path.join(dev.root, 'data/platform/accounts.sqlite')));
  assert(fs.existsSync(path.join(dev.root, 'config')));
  assert(!fs.existsSync(path.join(dev.root, 'local')));
  assert.equal(
    (await other.app.inject({ url: '/api/session', headers: owner.headers })).statusCode,
    401,
  );
  const created = await owner.post('/api/platform/dsps', { name: 'New test DSP', timezone: 'UTC' });
  assert.equal(created.statusCode, 201, created.body);
  const dsp = created.json().dsp;
  assert.equal(dsp.environment, 'preview');
  assert(!other.runtime.storage.platform.one('SELECT id FROM dsps WHERE id=?', dsp.id));
  for (const area of ['config', 'data', 'secrets', 'state'])
    assert.equal(fs.statSync(path.join(dev.root, 'dsps', dsp.id, area)).mode & 0o777, 0o700);
  await owner.select(dsp.id);
  assert.equal(
    (
      await owner.post('/api/dsp/connections/paycom', {
        clientCode: 'fixture',
        username: 'fixture',
        password: 'synthetic-password',
      })
    ).statusCode,
    200,
  );
  const job = (await owner.post('/api/dsp/jobs', { requestId: 'dev-own-queue' })).json();
  dev.runtime.start();
  await until(() => dev.runtime.runner.queue.get(job.id).status === 'succeeded');
  assert.equal((await owner.get('/api/dsp/employees')).json().total, 12);
  assert.equal((await owner.get('/api/platform/releases')).json().standalone, true);
  assert.equal(
    (await owner.post('/api/platform/releases/fake/deploy', { environment: 'production' }))
      .statusCode,
    409,
  );
});

test('standalone HTTPS Dev permits synthetic providers without insecure cookies or external mail', async (t) => {
  const dev = await fixture({ standalone: true, environment: 'preview' });
  t.after(() => dev.close());
  assert.throws(() => configuration({ standalone: true, previewOrigin: 'http://127.0.0.1:9999' }));
  assert.throws(() => configuration({ standalone: true, allowDeployment: true }));
  const config = configuration({
    standalone: true,
    environment: 'preview',
    development: false,
    providerMode: 'fixture',
    origin: 'https://dev.dispatch.test',
    stateRoot: dev.root,
  });
  const { createApp } = await import('../api/app.js');
  const app = await createApp(config);
  t.after(() => app.app.close());
  const login = await app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      host: 'dev.dispatch.test',
      origin: config.origin,
      'content-type': 'application/json',
    },
    payload: { email: 'owner@dispatch.test', password: 'Dispatch-demo-2026!' },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert(String(login.headers['set-cookie']).includes('Secure'));
  assert(
    app.runtime.mail.enqueue({ to: 'test@example.invalid', subject: 'Test', text: 'Local only' }),
  );
  await app.runtime.mail.tick();
  assert.equal(fs.readdirSync(path.join(dev.root, 'data/platform/development-mail')).length, 1);
});

test('standalone backup retains DSP state and clears restored web sessions', async (t) => {
  const f = await fixture({ standalone: true, environment: 'preview' });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-dev-backup-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const owner = await f.client();
  assert(owner.session.dsps.length);
  await f.app.close();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await backupState(f.root, path.join(parent, 'backup'), true);
  restoreState(path.join(parent, 'backup'), path.join(parent, 'restored'));
  const restored = new Storage(
    configuration({
      standalone: true,
      environment: 'preview',
      stateRoot: path.join(parent, 'restored'),
    }),
  );
  t.after(() => restored.close());
  assert.equal(restored.platform.one<{ n: number }>('SELECT count(*) n FROM sessions')!.n, 0);
  assert.equal(restored.platform.one<{ n: number }>('SELECT count(*) n FROM dsps')!.n, 3);
});
