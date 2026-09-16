import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, JobMetrics } from '../shared/contracts/index.js';
import { collectionHistory, runHistory } from '../dashboard/src/collection-history.js';

function job(
  index: number,
  values: Partial<Job> = {},
  measurements: Partial<JobMetrics> = {},
): Job {
  const at = new Date(Date.UTC(2026, 8, 1 + index)).toISOString();
  return {
    id: `job-${index}`,
    dspId: 'one',
    dspName: 'One',
    environment: 'preview',
    kind: 'paycom.collect',
    status: 'succeeded',
    progress: 100,
    message: 'Completed',
    attempt: 1,
    maxAttempts: 3,
    availableAt: at,
    createdAt: at,
    startedAt: at,
    completedAt: at,
    error: null,
    release: 'fixture',
    actorId: null,
    metrics: [
      {
        attempt: 1,
        startedAt: at,
        finishedAt: at,
        outcome: 'succeeded',
        error: null,
        phase: null,
        queueMs: 0,
        elapsedMs: 12000,
        authenticationMs: 2000,
        verificationMs: null,
        collectionMs: 10000,
        publicationMs: 0,
        employees: 10,
        timecards: 140,
        peakRssBytes: 200 * 1024 ** 2,
        peakPssBytes: 100 * 1024 ** 2,
        peakPrivateBytes: 80 * 1024 ** 2,
        memorySamples: 12,
        incompleteMemorySamples: 0,
        ...measurements,
      },
    ],
    ...values,
  };
}
test('history isolates DSPs and providers and requires five comparable baselines for warnings', () => {
  const jobs = [0, 1, 2, 3, 4].map((i) => job(i));
  jobs.push(job(5, {}, { collectionMs: 20000, peakPssBytes: 160 * 1024 ** 2 }));
  jobs.push(job(6, { dspId: 'two', dspName: 'Two' }));
  jobs.push(job(7, { kind: 'cortex.meal_breaks.collect' }, { itineraries: 10, employees: null }));
  const groups = collectionHistory(jobs);
  assert.equal(groups.length, 3);
  const paycom = groups.find((g) => g.key === 'one:paycom.collect')!;
  assert.equal(paycom.runs.length, 6);
  assert.equal(paycom.medianMs, 10000);
  assert.equal(paycom.p95Ms, 20000);
  assert.equal(paycom.warnings.length, 2);
  assert(paycom.warnings[0]!.includes('100% longer per employee'));
  assert.equal(groups.find((g) => g.key === 'one:cortex.meal_breaks.collect')!.warnings.length, 0);
  assert.equal(collectionHistory(jobs.slice(1, 6))[0]!.warnings.length, 0);
  assert.deepEqual(collectionHistory([]), []);
});
test('speed comparisons account for workload and exclude resumed or retried runs', () => {
  const jobs = [0, 1, 2, 3, 4].map((i) => job(i));
  const larger = job(5, {}, { collectionMs: 20000, employees: 20 });
  assert.equal(collectionHistory([...jobs, larger])[0]!.warnings.length, 0);
  const resumed = job(
    6,
    {},
    {
      collectionMs: 100000,
      pageReads: {
        completed: 1,
        resumed: 9,
        retries: 0,
        recovered: 0,
        totalMs: 100000,
        active: [],
        slowest: [],
        failures: [],
      },
    },
  );
  assert.equal(collectionHistory([...jobs, resumed])[0]!.warnings.length, 0);
  const retry = job(7, { attempt: 2 }, { collectionMs: 100000 });
  assert.equal(collectionHistory([...jobs, retry])[0]!.warnings.length, 0);
  assert.equal(collectionHistory([larger, resumed, retry])[0]!.samples, 1);
});
test('failed jobs do not advance freshness; missing metrics stay unknown and retries sum across attempts', () => {
  const success = job(1),
    failed = job(2, { status: 'failed' }, { outcome: 'failed' });
  const history = collectionHistory([success, failed])[0]!;
  assert.equal(history.latest!.job.id, success.id);
  assert.equal(history.warnings.length, 1);
  assert.equal(runHistory(job(3, { metrics: [] })).collectionMs, null);
  assert.equal(runHistory(job(3, { metrics: [] })).peakBytes, null);
  const retried = job(4, { attempt: 2 });
  retried.metrics.unshift({ ...retried.metrics[0]!, outcome: 'interrupted', collectionMs: 4000 });
  const run = runHistory(retried);
  assert.equal(run.collectionMs, 14000);
  assert.equal(run.partial, true);
  assert.equal(run.jobRetries, 1);
  assert.equal(run.comparable, false);
});
