'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execute, safeFailure } = require('../src/collector');
const { PaycomStore, stageCandidate, cleanupRunStages } = require('../src/store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-cleanup-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stagingRoot: path.join(root, 'staging'), database: path.join(root, 'db/paycom.sqlite3'),
    businessClock: () => new Date('2026-08-30T18:00:00.000Z') };
}
function request() {
  return { protocolVersion: 1, runId: 'cleanup-run', attempt: 2, plan: 'paycom-periods',
    source: { id: 'paycom-main', collector: 'paycom', authProfile: 'paycom-main',
      config: { timezone: 'UTC', maxConcurrency: 1 } },
    method: 'pay-periods.discover', input: {}, deadline: new Date(Date.now() + 60000).toISOString() };
}
function leavePartial(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, '.candidate.tmp'), 'partial fixture', { mode: 0o600 });
}

test('partial staging writes and rename failures remove their owned files', t => {
  const { stagingRoot } = fixture(t);
  const candidate = { kind: 'roster', target: '2026-09-05', runId: 'partial-run', attempt: 1,
    collectedAt: '2026-08-30T18:00:00.000Z', metadata: {},
    rows: [{ employeeCode: 'A001', employeeName: 'Fixture', isActive: true, isActiveDriver: true }] };
  for (const method of ['writeFileSync', 'renameSync']) {
    const original = fs[method];
    const mocked = t.mock.method(fs, method, (...args) => {
      if (method === 'writeFileSync') original(...args);
      throw Object.assign(new Error('fixture_io_failure'), { code: 'ENOSPC' });
    });
    try { assert.throws(() => stageCandidate(stagingRoot, candidate), /fixture_io_failure/); }
    finally { mocked.mock.restore(); }
    assert.deepEqual(fs.readdirSync(stagingRoot), []);
  }
});

test('successful publication removes all of its attempts and preserves other runs', async t => {
  const paths = fixture(t);
  leavePartial(path.join(paths.stagingRoot, 'cleanup-run.attempt-1'));
  const other = path.join(paths.stagingRoot, 'other-run.attempt-1');
  leavePartial(other);
  const result = await execute(request(), paths);
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(paths.stagingRoot), ['other-run.attempt-1']);
  assert.equal(fs.readFileSync(path.join(other, '.candidate.tmp'), 'utf8'), 'partial fixture');
  const store = new PaycomStore(paths.database, { readOnly: true });
  try { assert.equal(store.audit('pay_periods').verified, true); }
  finally { store.close(); }
});

test('leftover files prevent a success acknowledgement; retry keeps committed data and finishes cleanup', async t => {
  const paths = fixture(t);
  const owned = path.join(paths.stagingRoot, 'cleanup-run.attempt-2');
  const remove = fs.rmSync;
  // Also proves cleanup verifies absence rather than trusting a return value.
  const mocked = t.mock.method(fs, 'rmSync', (directory, options) => directory === owned ? undefined : remove(directory, options));
  try {
    await assert.rejects(execute(request(), paths), error => {
      assert.equal(safeFailure(error).error.code, 'stage_cleanup_failed');
      return true;
    });
  } finally { mocked.mock.restore(); }
  assert.equal(fs.existsSync(owned), true);
  const store = new PaycomStore(paths.database, { readOnly: true });
  try { assert.equal(store.audit('pay_periods').verified, true); }
  finally { store.close(); }
  assert.equal((await execute(request(), paths)).status, 'no_change');
  assert.deepEqual(fs.readdirSync(paths.stagingRoot), []);
});

test('cleanup refuses links outside the private staging root', t => {
  const paths = fixture(t);
  const outside = path.join(paths.root, 'retained');
  leavePartial(outside);
  fs.mkdirSync(paths.stagingRoot, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(paths.stagingRoot, 'cleanup-run.attempt-1'));
  assert.throws(() => cleanupRunStages(paths.stagingRoot, 'cleanup-run'), /stage_cleanup_failed/);
  assert.equal(fs.readFileSync(path.join(outside, '.candidate.tmp'), 'utf8'), 'partial fixture');
});
