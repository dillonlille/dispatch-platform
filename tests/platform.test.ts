import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { fixtureWorkforce } from '../integrations/paycom/fixture.js';
import { sha256 } from '../shared/crypto.js';
import { nextOccurrence } from '../services/jobs/schedule.js';
import { privateFile } from '../services/storage/paths.js';

test('authentication, CSRF, view tampering and role boundaries fail closed', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const owner = await f.client(),
    member = await f.client('member@dispatch.test');
  assert.equal(member.session.dsps.length, 1);
  assert.equal((await member.get('/api/platform/dsps')).statusCode, 403);
  const north = member.session.dsps[0]!,
    dev = owner.session.dsps.find((d) => d.permanent)!;
  const response = await member.post('/api/session/dsp', { dspId: dev.id });
  assert.equal(response.statusCode, 403);
  await member.select(north.id);
  assert.equal((await member.get('/api/dsp/employees')).json().total, 12);
  assert.equal((await member.get('/api/dsp/connections')).statusCode, 403);
  assert.equal((await member.get('/api/dsp/invitations')).statusCode, 403);
  assert.equal((await member.get('/api/dsp/audit')).statusCode, 403);
  assert.equal((await member.post('/api/dsp/jobs', { requestId: 'forbidden' })).statusCode, 403);
  const value = member.headers['x-dispatch-view']!;
  member.headers['x-dispatch-view'] = value.slice(0, -1) + (value.endsWith('x') ? 'y' : 'x');
  assert.equal((await member.get('/api/dsp/employees')).statusCode, 409);
  member.headers['x-dispatch-view'] = value;
  delete member.headers['x-csrf-token'];
  assert.equal((await member.post('/api/session/dsp', { dspId: north.id })).statusCode, 403);
  const cross = await f.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: '127.0.0.1:5173', origin: 'https://attacker.invalid' },
    payload: { email: 'owner@dispatch.test', password: 'anything' },
  });
  assert.equal(cross.statusCode, 403);
  assert.equal(
    (await f.app.inject({ url: '/api/health', headers: { host: 'attacker.invalid' } })).statusCode,
    400,
  );
  assert(!JSON.stringify(owner.session).includes('password'));
  assert(!JSON.stringify(owner.session).includes('vault'));
});

test('DSP creation has only private state; permanent Dev cannot be suspended', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const client = await f.client();
  const response = await client.post('/api/platform/dsps', {
    name: 'Fresh Logistics',
    timezone: 'America/Denver',
    ownerEmail: 'fresh@example.test',
  });
  assert.equal(response.statusCode, 201, response.body);
  const { dsp, invitationUrl } = response.json();
  assert.deepEqual(fs.readdirSync(f.runtime.storage.paths.dsp(dsp.id)).sort(), [
    'config',
    'data',
    'secrets',
    'state',
  ]);
  assert.equal(fs.statSync(f.runtime.storage.paths.dsp(dsp.id)).mode & 0o077, 0);
  assert(invitationUrl.includes('#invite?token='));
  assert.equal(
    (
      await client.post(
        `/api/platform/dsps/${client.session.dsps.find((d) => d.permanent)!.id}/status`,
        { status: 'suspended' },
      )
    ).statusCode,
    409,
  );
  await client.select(dsp.id);
  const invitations = (await client.get('/api/dsp/invitations')).json();
  assert.equal(invitations.length, 1);
  assert.equal(invitations[0].email, 'fresh@example.test');
  assert(!JSON.stringify(invitations).includes('hash'));
  assert(!JSON.stringify(invitations).includes('token'));
  assert(
    (await client.get('/api/dsp/audit'))
      .json()
      .every((event: { dspId: string }) => event.dspId === dsp.id),
  );
  const summaries = (await client.get('/api/platform/dsps')).json();
  assert.equal(
    summaries.find((item: { id: string }) => item.id === dsp.id).ownerEmail,
    'fresh@example.test',
  );
  assert.equal(summaries.find((item: { id: string }) => item.id === dsp.id).ownerStatus, 'invited');
  const old = client.headers['x-dispatch-view'];
  assert.equal(
    (await client.post('/api/dsp/settings', { name: 'Fresh Updated', timezone: 'UTC' })).statusCode,
    200,
  );
  assert.equal((await client.get('/api/dsp/employees')).statusCode, 409);
  await client.select(dsp.id);
  assert.notEqual(old, client.headers['x-dispatch-view']);
});

test('invitations are single use, existing accounts require password, reset revokes all sessions', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d) => d.name === 'Northline Logistics')!;
  await owner.select(dsp.id);
  const invitation = (
    await owner.post('/api/dsp/members/invite', { email: 'new@example.test', role: 'owner' })
  ).json().invitationUrl;
  const token = invitation.split('token=')[1];
  const accepted = await owner.post(`/api/invitations/${token}/accept`, {
    firstName: 'New',
    lastName: 'Owner',
    password: 'New-owner-password!',
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(
    (
      await owner.post(`/api/invitations/${token}/accept`, {
        firstName: 'Replay',
        lastName: 'Owner',
        password: 'New-owner-password!',
      })
    ).statusCode,
    404,
  );
  const first = await f.client('new@example.test', 'New-owner-password!'),
    second = await f.client('new@example.test', 'New-owner-password!');
  await first.select(dsp.id);
  const member = f.runtime.dsps.members(dsp.id).find((m) => m.email === 'new@example.test')!;
  assert.equal(
    (await first.post(`/api/dsp/members/${member.id}`, { role: 'member' })).statusCode,
    409,
  );
  const recovery = f.runtime.accounts.recoveryToken('new@example.test')!;
  assert(!f.runtime.storage.platform.one('SELECT * FROM resets WHERE hash=?', recovery.raw));
  assert(f.runtime.storage.platform.one('SELECT * FROM resets WHERE hash=?', sha256(recovery.raw)));
  await f.runtime.accounts.resetPassword(recovery.raw, 'Updated-owner-password!');
  assert.equal((await first.get('/api/session')).statusCode, 401);
  assert.equal((await second.get('/api/session')).statusCode, 401);
  await assert.rejects(f.runtime.accounts.resetPassword(recovery.raw, 'Another-owner-password!'));
});

test('credential ciphertext is DSP-bound and disconnect removes credentials and schedule', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.client();
  const a = c.session.dsps.find((d) => d.name === 'Northline Logistics')!,
    b = c.session.dsps.find((d) => d.name === 'Summit Delivery')!;
  await c.select(a.id);
  const response = await c.post('/api/dsp/connections/paycom', {
    clientCode: 'TEST',
    username: 'private-user',
    password: 'require-verification',
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'needs_verification');
  assert.equal(
    (await c.post('/api/dsp/connections/paycom/verify', { code: 'wrong' })).statusCode,
    409,
  );
  assert.equal(
    (await c.post('/api/dsp/connections/paycom/verify', { code: '123456' })).json().status,
    'ready',
  );
  const secrets = f.runtime.storage.paths.dspArea(a.id, 'secrets'),
    bytes = fs.readFileSync(path.join(secrets, 'paycom.enc'), 'utf8');
  assert(!bytes.includes('private-user'));
  assert(!bytes.includes('require-verification'));
  const dest = f.runtime.storage.paths.dspArea(b.id, 'secrets');
  fs.copyFileSync(path.join(secrets, 'paycom.enc'), path.join(dest, 'paycom.enc'));
  fs.copyFileSync(path.join(secrets, 'vault.key'), path.join(dest, 'vault.key'));
  assert.throws(() => f.runtime.broker.vault.read(b.id));
  assert.equal(
    (await c.post('/api/dsp/schedule', { enabled: true, localTime: '06:00' })).statusCode,
    200,
  );
  await c.post('/api/dsp/connections/paycom/disable', { removeCredentials: true });
  assert.equal(f.runtime.runner.schedules.get(a.id).enabled, false);
  assert.throws(() => f.runtime.broker.vault.read(a.id));
  const link = path.join(secrets, 'dangling');
  fs.symlinkSync('/tmp/does-not-exist-dispatch', link);
  assert.throws(() => privateFile(link));
});

test('jobs publish atomically, cancel safely, and remain isolated between production and Dev', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.client();
  const north = c.session.dsps.find((d) => d.name === 'Northline Logistics')!,
    dev = c.session.dsps.find((d) => d.permanent)!;
  await c.select(north.id);
  const queued = await c.post('/api/dsp/jobs', { requestId: 'same-request' });
  assert.equal(queued.statusCode, 202, queued.body);
  const job = queued.json();
  assert.equal((await c.post('/api/dsp/jobs', { requestId: 'same-request' })).json().id, job.id);
  await f.runtime.runner.tick();
  await until(() => f.runtime.runner.queue.get(job.id).status === 'succeeded');
  assert.equal(f.runtime.runner.workforce.employees(north.id).total, 12);
  await c.select(dev.id);
  const devJob = (await c.post('/api/dsp/jobs', { requestId: 'dev-request' })).json();
  assert.throws(() => f.runtime.runner.queue.get(devJob.id));
  await f.preview!.runner.tick();
  await until(() => f.preview!.runner.queue.get(devJob.id).status === 'succeeded');
  await c.select(north.id);
  const pending = (await c.post('/api/dsp/jobs', { requestId: 'cancel-request' })).json();
  assert.equal((await c.post(`/api/dsp/jobs/${pending.id}/cancel`, {})).json().status, 'cancelled');
  const original = f.runtime.runner.workforce.employees(north.id);
  const bad = fixtureWorkforce(north);
  bad.timecards[0]!.employeeCode = 'FOREIGN';
  assert.throws(() => f.runtime.runner.workforce.publish(north.id, bad));
  assert.deepEqual(f.runtime.runner.workforce.employees(north.id), original);
  assert.throws(() =>
    f.runtime.runner.workforce.publish(north.id, fixtureWorkforce(north), () => {
      throw Error('revoked');
    }),
  );
  assert.deepEqual(f.runtime.runner.workforce.employees(north.id), original);
});

test('queue capacity, expired lease recovery and DST scheduling', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await f.client(),
    north = c.session.dsps.find((d) => d.name === 'Northline Logistics')!;
  const q = f.runtime.runner.queue;
  const job = q.enqueue(north.id, c.session.user.id, 'recover');
  q.claim('crashed');
  f.runtime.storage.jobs.run('UPDATE jobs SET lease_until=? WHERE id=?', Date.now() - 10, job.id);
  assert.equal(q.recover(), 1);
  assert.equal(q.get(job.id).status, 'queued');
  assert.equal(q.claim('replacement')?.attempt, 2);
  for (let i = 0; i < 4; i++) q.enqueue(north.id, c.session.user.id, `queued-${i}`);
  assert.throws(() => q.enqueue(north.id, c.session.user.id, 'overflow'));
  assert.equal(q.claim('second'), null);
  assert.equal(
    nextOccurrence('06:00', 'America/Chicago', new Date('2026-03-07T13:00:00Z')),
    '2026-03-08T11:00:00.000Z',
  );
});

test('manual authentication sessions reserve browser capacity without burning queued job attempts', async (t) => {
  const f = await fixture({ browserCapacity: 1 });
  t.after(() => f.close());
  const c = await f.client();
  const north = c.session.dsps.find((d) => d.name === 'Northline Logistics')!,
    summit = c.session.dsps.find((d) => d.name === 'Summit Delivery')!;
  await f.runtime.broker.ensure(north);
  f.runtime.broker.vault.save(summit.id, {
    clientCode: 'fixture',
    username: 'fixture',
    password: 'fixture',
  });
  f.runtime.storage.dsp(summit.id, (db) => db.run('UPDATE connections SET enabled=1'));
  const job = f.runtime.runner.queue.enqueue(summit.id, c.session.user.id, 'capacity-wait');
  await f.runtime.runner.tick();
  assert.equal(f.runtime.runner.queue.get(job.id).status, 'queued');
  assert.equal(f.runtime.runner.queue.get(job.id).attempt, 0);
  await f.runtime.browsers.revoke(north.id);
  await f.runtime.runner.tick();
  await until(() => f.runtime.runner.queue.get(job.id).status === 'succeeded');
});

test('development mail stays in private files even when an SMTP URL is inherited', async (t) => {
  const f = await fixture({ smtpUrl: 'smtp://127.0.0.1:1', mailFrom: 'fixture@dispatch.test' });
  t.after(() => f.close());
  f.runtime.mail.enqueue({
    to: 'fixture@example.test',
    subject: 'Development only',
    text: 'Synthetic invitation',
  });
  await f.runtime.mail.tick();
  const directory = path.join(f.runtime.storage.paths.platform, 'development-mail');
  assert.equal(fs.readdirSync(directory).length, 1);
  assert.equal(
    f.runtime.storage.platform.one<{ status: string }>('SELECT status FROM outbox')!.status,
    'sent',
  );
});
