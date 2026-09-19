import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './support.js';

const credentials = { username: 'private-cortex-user', password: 'require-verification' };
test('Cortex owns its database, secrets and verification independently of Paycom and other DSPs', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  const paycom = (await owner.get('/api/dsp/connections')).value;
  assert.equal((await owner.get('/api/dsp/connections/cortex')).value.enabled, false);
  const member = await f.client('member@dispatch.test');
  await member.select(north.id);
  assert.equal((await member.get('/api/dsp/connections/cortex')).status, 403);
  assert.equal((await member.post('/api/dsp/connections/cortex', credentials)).status, 403);
  assert.equal((await owner.post('/api/dsp/connections/unknown', credentials)).status, 404);
  assert.equal(
    (
      await owner.post('/api/dsp/connections/cortex', {
        ...credentials,
        clientCode: 'wrong-provider',
      })
    ).status,
    400,
  );
  const profile = path.join(f.root, 'dsps', north.id, 'state/browsers/paycom-browseros');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'sentinel'), 'preserve');
  const saved = await owner.post('/api/dsp/connections/cortex', credentials);
  assert.equal(saved.status, 200, saved.body);
  assert.equal(saved.value.status, 'needs_verification');
  assert.equal(
    (await owner.post('/api/dsp/connections/cortex/verify', { code: 'wrong' })).status,
    409,
  );
  assert.equal(
    (await owner.post('/api/dsp/connections/cortex/verify', { code: '123456' })).value.status,
    'ready',
  );
  assert.deepEqual((await owner.get('/api/dsp/connections')).value, paycom);
  assert.equal(fs.readFileSync(path.join(profile, 'sentinel'), 'utf8'), 'preserve');
  const encrypted = path.join(f.root, 'dsps', north.id, 'secrets/cortex.enc');
  for (const secret of Object.values(credentials))
    assert(!fs.readFileSync(encrypted, 'utf8').includes(secret));
  assert.equal(fs.statSync(encrypted).mode & 0o077, 0);
  f.database(`dsps/${north.id}/data/cortex/cortex.sqlite`, (db) => {
    assert.equal(
      (db.prepare('SELECT provider FROM storage_identity').get() as any).provider,
      'cortex',
    );
    assert.equal(
      (db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='publications'").get() as any).n,
      0,
    );
  });
  const dev = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
  await owner.select(dev.id);
  assert.equal((await owner.get('/api/dsp/connections/cortex')).value.enabled, false);
  await owner.select(north.id);
  await f.stop();
  await f.start();
  const restarted = await f.client();
  await restarted.select(north.id);
  assert.equal((await restarted.get('/api/dsp/connections/cortex')).value.status, 'ready');
  assert.equal(
    (await restarted.post('/api/dsp/connections/cortex/disable', { removeCredentials: true }))
      .status,
    200,
  );
  assert(!fs.existsSync(encrypted));
  assert.equal((await restarted.get('/api/dsp/connections')).value.status, 'ready');
  assert.equal(fs.readFileSync(path.join(profile, 'sentinel'), 'utf8'), 'preserve');
});
