import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { demo, fixture } from '../support/support.js';
const { password } = demo;

test('Rust bootstrap creates only the initial owner and empty Dev DSP; locks exclude another core and backup', async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  const owner = await f.client();
  assert.equal(owner.session.dsps.length, 1);
  await owner.select(owner.session.dsps[0].id);
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
  assert.equal((await owner.get('/api/dsp/connections')).value.enabled, false);
  assert.equal((await owner.get('/api/dsp/jobs')).value.length, 0);
  assert.throws(() => f.cli(['serve']), /stop_services_before_operation/);
  assert.throws(() => f.cli(['backup', `${f.root}-backup`]), /stop_services_before_operation/);
  assert.equal(fs.readFileSync(`/proc/${f.pid()}/comm`, 'utf8').trim(), 'dispatch-backen');
  assert.equal(fs.readFileSync(`/proc/${f.pid()}/task/${f.pid()}/children`, 'utf8').trim(), '');
  await f.stop();
  assert.throws(
    () => f.cli(['bootstrap', 'again@dispatch.test', 'Again', 'Owner'], password),
    /bootstrap_requires_empty_platform/,
  );
});

test('Rust backup and restore validate checksums, exclude runtime locks and revoke web capabilities', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const backup = `${f.root}-backup`,
    restored = `${f.root}-restored`;
  t.after(() => {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(restored, { recursive: true, force: true });
  });
  await f.stop();
  f.cli(['backup', backup]);
  f.cli(['restore', backup, restored]);
  const db = new DatabaseSync(path.join(restored, 'data/platform/accounts.sqlite'));
  assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n, 0);
  db.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'backup.json'), 'utf8'));
  assert(!manifest.files.some((file: { path: string }) => file.path.endsWith('.lock')));
  const providerFiles = manifest.files.filter((file: { path: string }) =>
    file.path.endsWith('/data/paycom/paycom.sqlite'),
  );
  assert.equal(providerFiles.length, 3);
  for (const file of providerFiles) {
    const provider = new DatabaseSync(path.join(restored, file.path), { readOnly: true });
    assert.equal(provider.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(
      provider.prepare('SELECT provider FROM storage_identity').get()!.provider,
      'paycom',
    );
    provider.close();
  }

  fs.appendFileSync(path.join(backup, manifest.files[0].path), 'tampered');
  fs.rmSync(restored, { recursive: true });
  assert.throws(() => f.cli(['restore', backup, restored]), /backup_checksum_failed/);
  assert.equal(fs.existsSync(restored), false);
  await f.start();
  assert.equal((await owner.get('/api/session')).status, 200);
});

test('SQLite write contention leaves health responsive and the pending write recovers after unlock', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const db = new DatabaseSync(path.join(f.root, 'data/platform/accounts.sqlite'));
  let pending: Promise<unknown> | undefined;
  try {
    db.exec('BEGIN IMMEDIATE');
    pending = owner.post('/api/platform/dsps', { ownerEmail: 'blocked@dispatch.test' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    assert.equal((await f.request('/api/health')).status, 200);
    assert(Date.now() - started < 500);
    db.exec('ROLLBACK');
    assert.equal(((await pending) as { status: number }).status, 201);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    await pending;
  }
});
