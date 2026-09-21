import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until, seedQueuedJob } from '../support/support.js';
const credentials = {
  clientCode: 'TEST',
  username: 'private-user',
  password: 'synthetic-password',
  securityAnswers: ['00123', 'two', 'three', 'four', 'five'],
};

test('Rust owns verification, encrypted credentials, collection, idempotency and disabling schedules', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  assert.equal(
    (
      await owner.post('/api/dsp/connections/paycom', {
        ...credentials,
        securityAnswers: ['1', '1', '3', '4', '5'],
      })
    ).status,
    400,
  );
  const saved = await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.status, 'needs_verification');
  const vault = path.join(f.root, 'dsps', dsp.id, 'secrets/paycom.enc');
  assert(!fs.readFileSync(vault, 'utf8').includes('private-user'));
  assert.equal(fs.statSync(vault).mode & 0o077, 0);
  const job = await owner.post('/api/dsp/jobs', { requestId: 'one' });
  assert.equal(job.status, 202);
  assert.equal((await owner.post('/api/dsp/jobs', { requestId: 'one' })).value.id, job.value.id);
  await until(
    async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'waiting_verification',
  );
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/verify', { code: 'bad' })).status,
    409,
  );
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/verify', { code: '123456' })).status,
    200,
  );
  await until(async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'succeeded');
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 12);
  const schedule = await owner.post('/api/dsp/schedules', {
    name: 'Morning',
    collection: 'paycom',
    cadence: 'daily',
    intervalMinutes: null,
    localTime: '06:00',
    enabled: true,
  });
  assert.equal(schedule.status, 201);
  assert.equal(schedule.value.enabled, true);
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/disable', { removeCredentials: true })).status,
    200,
  );
  assert.equal(fs.existsSync(vault), false);
  const paused = (await owner.get('/api/dsp/schedules')).value.schedules;
  assert.deepEqual(
    paused.map((s: { id: string; enabled: boolean; nextRun: string | null }) => [
      s.id,
      s.enabled,
      s.nextRun,
    ]),
    [[schedule.value.id, false, null]],
  );
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 12);
});

test('Rust cancellation and suspension prevent late publication; restart recovers interrupted collection', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  const first = await owner.post('/api/dsp/jobs', { requestId: 'cancel-me' });
  await until(
    async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'waiting_verification',
  );
  assert.equal(
    (await owner.post(`/api/dsp/jobs/${first.value.id}/cancel`)).value.status,
    'cancelled',
  );
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
  await owner.post('/api/dsp/jobs', { requestId: 'restart-me' });
  await until(
    async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'waiting_verification',
  );
  await f.stop('SIGKILL');
  await f.start();
  owner = await f.client();
  await owner.select(dsp.id);
  await until(async () => {
    const row = (await owner.get('/api/dsp/jobs')).value[0];
    return row.status === 'waiting_verification' && row.attempt === 2;
  });
  await owner.post(`/api/platform/dsps/${dsp.id}/status`, { status: 'suspended' });
  const jobs = (await owner.get('/api/platform/jobs')).value;
  assert(
    jobs
      .filter((j: { dspId: string }) => j.dspId === dsp.id)
      .every((j: { status: string }) => j.status === 'cancelled'),
  );
});

test('cancelling a queued job preserves the active verification session and does not consume another attempt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  const first = (await owner.post('/api/dsp/jobs', { requestId: 'active' })).value;
  await until(async () =>
    (await owner.get('/api/dsp/jobs')).value.some(
      (j: { id: string; status: string }) =>
        j.id === first.id && j.status === 'waiting_verification',
    ),
  );
  const blocked = await owner.post('/api/dsp/jobs', { requestId: 'queued' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.value.error, 'sync_in_progress');
  // A queue retained from an older release can still be cancelled safely.
  const second = seedQueuedJob(f, first.id, 'legacy-queued');
  assert.equal((await owner.post(`/api/dsp/jobs/${second.id}/cancel`)).value.status, 'cancelled');
  assert.equal((await owner.get('/api/dsp/connections')).value.status, 'needs_verification');
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/verify', { code: '123456' })).status,
    200,
  );
  await until(async () =>
    (await owner.get('/api/dsp/jobs')).value.some(
      (j: { id: string; status: string }) => j.id === first.id && j.status === 'succeeded',
    ),
  );
  const cancelled = (await owner.get('/api/dsp/jobs')).value.find(
    (j: { id: string }) => j.id === second.id,
  );
  assert.equal(cancelled.attempt, 0);
  assert.equal(cancelled.status, 'cancelled');
});
