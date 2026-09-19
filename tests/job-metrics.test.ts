import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './rust-support.js';
import type { Job } from '../shared/contracts/index.js';

const credentials = {
  clientCode: 'metrics-client',
  username: 'metrics-user',
  password: 'metrics-secret',
  securityAnswers: ['one', 'two', 'three', 'four', 'five'],
};
test('collection metrics survive restart and an additive upgrade preserves old jobs', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
    'ready',
  );
  const id = (await owner.post('/api/dsp/jobs', { requestId: 'metrics-success' })).value.id;
  let job: Job;
  await until(async () => {
    job = (await owner.get('/api/dsp/jobs')).value.find((j: Job) => j.id === id);
    return job.status === 'succeeded';
  });
  const metrics = job!.metrics;
  assert.equal(metrics.length, 1);
  const value = metrics[0]!;
  assert.equal(value.outcome, 'succeeded');
  assert.equal(value.phase, null);
  assert(value.finishedAt);
  assert(value.queueMs >= 0);
  assert(value.authenticationMs !== null);
  assert(value.collectionMs! >= 90);
  assert(value.publicationMs !== null);
  assert.equal(value.verificationMs, null);
  assert.equal(value.employees, 12);
  assert.equal(value.timecards, 84);
  assert.equal(value.peakPssBytes, null, 'Synthetic provider has no browser to sample');
  for (const secret of [credentials.username, credentials.password, f.root]) {
    assert(!JSON.stringify(metrics).includes(secret));
  }
  await f.stop();
  await f.start();
  owner = await f.client();
  await owner.select(dsp.id);
  assert.deepEqual(
    (await owner.get('/api/dsp/jobs')).value.find((j: Job) => j.id === id).metrics,
    metrics,
  );
  await f.stop();
  // A database from a release without job_metrics: that release recorded no migrations either.
  f.database('data/preview/jobs.sqlite', (db) =>
    db.exec('DROP TABLE job_metrics; DROP TABLE schema_migrations'),
  );
  await f.start();
  owner = await f.client();
  await owner.select(dsp.id);
  const older = (await owner.get('/api/dsp/jobs')).value.find((j: Job) => j.id === id);
  assert.equal(older.status, 'succeeded');
  assert.deepEqual(older.metrics, [], 'Do not invent historical measurements');
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 12);
});

test('interruption, waiting for verification and cancellation preserve separate attempt metrics', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  const id = (await owner.post('/api/dsp/jobs', { requestId: 'metrics-interruption' })).value.id;
  const current = async (): Promise<Job> =>
    (await owner.get('/api/dsp/jobs')).value.find((j: Job) => j.id === id);
  await until(async () => (await current()).metrics[0]?.verificationMs! > 0);
  const queued = (await owner.post('/api/dsp/jobs', { requestId: 'metrics-cancel-queued' })).value;
  const cancelled = (await owner.post(`/api/dsp/jobs/${queued.id}/cancel`)).value;
  assert.equal(cancelled.attempt, 0);
  assert.deepEqual(cancelled.metrics, []);
  await f.stop('SIGKILL');
  await f.start();
  owner = await f.client();
  await owner.select(dsp.id);
  await until(async () => {
    const job = await current();
    return job.attempt === 2 && job.status === 'waiting_verification';
  });
  let job = await current();
  assert.equal(job.metrics[0]!.outcome, 'interrupted');
  assert.equal(job.metrics[0]!.error, 'worker_interrupted');
  assert.equal(job.metrics[0]!.phase, null);
  assert(job.metrics[0]!.finishedAt);
  assert.equal(job.metrics[1]!.outcome, 'running');
  assert.equal(job.metrics[1]!.attempt, 2);
  const interrupted = job.metrics[0];
  await owner.post(`/api/dsp/jobs/${id}/cancel`);
  await until(async () => (await current()).metrics[1]?.outcome === 'cancelled');
  job = await current();
  assert.deepEqual(job.metrics[0], interrupted);
  assert.equal(job.metrics[1]!.collectionMs, null);
  assert.equal(job.metrics[1]!.publicationMs, null);
});
