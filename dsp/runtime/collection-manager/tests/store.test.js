'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { fixture, spec } = require('./helpers');

test('spec application creates collectors, sources, plans, and durable queued runs', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    assert.deepEqual(store.applySpec(spec()), { collectors: 1, sources: 1, plans: 4, syncs: 1 });
    assert.equal(store.collectors().length, 1);
    assert.equal(store.methods('fixture').length, 3);
    assert.equal(store.sources().length, 1);
    assert.equal(store.plans().length, 4);
    assert.equal(store.syncs().length, 1);
    const run = store.enqueuePlan('fixture-snapshot', { input: { label: 'manual' } });
    assert.equal(run.status, 'queued');
    assert.equal(run.method, 'fixture.snapshot');
    assert.equal(fs.statSync(paths.databaseRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.database).mode & 0o777, 0o600);
    assert.equal(store.health().databaseIntegrity, 'ok');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spec validation rejects secret-bearing source configuration', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    for (const key of ['password', 'accessToken', 'credential', 'privateKey', 'sessionCookie']) {
      const invalid = spec();
      invalid.sources[0].config[key] = 'not-allowed';
      assert.throws(() => store.applySpec(invalid), error => error.code === 'secret_field_forbidden');
    }
    assert.equal(store.collectors().length, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spec application rejects dependency cycles and unsafe executable parents', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    const cyclic = spec();
    cyclic.plans[0].dependsOn = [{ plan: 'fixture-retry', maxAgeSeconds: 60 }];
    cyclic.plans[1].dependsOn = [{ plan: 'fixture-snapshot', maxAgeSeconds: 60 }];
    assert.throws(() => store.applySpec(cyclic), error => error.code === 'dependency_cycle');

    const unsafeDirectory = `${root}/unsafe`;
    const unsafeCommand = `${unsafeDirectory}/collector`;
    fs.mkdirSync(unsafeDirectory, { mode: 0o777 });
    fs.copyFileSync(spec().collectors[0].command, unsafeCommand);
    fs.chmodSync(unsafeDirectory, 0o777);
    fs.chmodSync(unsafeCommand, 0o700);
    const unsafe = spec();
    unsafe.collectors[0].command = unsafeCommand;
    assert.throws(() => store.applySpec(unsafe), error => error.code === 'unsafe_collector');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expired managers are fenced from completing runs', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec(), 1_000);
    const run = store.enqueuePlan('fixture-snapshot', { timestamp: 1_000 });
    const firstEpoch = store.claimManager('manager-one', 111, 1_000, 100);
    assert.equal(store.claimRun(run.id, ['source:fixture-main'], 1_000,
      { instanceId: 'manager-one', epoch: firstEpoch }), true);
    const secondEpoch = store.claimManager('manager-two', 222, 1_101, 100);
    assert.ok(secondEpoch > firstEpoch);
    assert.throws(() => store.finishRun(run.id, { success: false, errorCode: 'stale' }, 1_101,
      { instanceId: 'manager-one', epoch: firstEpoch }), error => error.code === 'manager_lease_lost');
    assert.equal(store.run(run.id).status, 'running');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('polling-window runs retry only declared availability errors and stop at the cutoff', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec(), 1_000);
    const manager = {
      instanceId: 'poll-manager',
      epoch: store.claimManager('poll-manager', 333, 1_000, 10_000_000),
    };
    const policy = {
      maxAttempts: 4, backoffSeconds: [900], retryDeadline: 4_000_000,
      retryErrors: ['week_unavailable'],
    };

    const unavailable = store.enqueuePlan('fixture-snapshot', { timestamp: 1_000, runPolicy: policy });
    assert.equal(store.claimRun(unavailable.id, ['source:fixture-main'], 1_000, manager), true);
    const deferred = store.finishRun(unavailable.id, {
      success: false, errorCode: 'week_unavailable', exitCode: 0,
    }, 2_000, manager);
    assert.equal(deferred.status, 'queued');
    assert.equal(deferred.runAfter, 902_000);
    assert.equal(deferred.retryDeadline, 4_000_000);

    const authentication = store.enqueuePlan('fixture-snapshot', { timestamp: 3_000, runPolicy: policy });
    assert.equal(store.claimRun(authentication.id, ['source:fixture-main'], 3_000, manager), true);
    const terminal = store.finishRun(authentication.id, {
      success: false, errorCode: 'authentication_required', exitCode: 0,
    }, 4_000, manager);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error, 'authentication_required');

    const expired = store.enqueuePlan('fixture-snapshot', {
      timestamp: 5_000,
      runPolicy: { ...policy, retryDeadline: 5_000 },
    });
    assert.equal(store.expirePollingRun(expired.id, 5_000), true);
    assert.equal(store.run(expired.id).error, 'polling_window_expired');
    const manualRetry = store.retry(expired.id);
    assert.equal(manualRetry.status, 'queued');
    assert.equal(manualRetry.retryDeadline, null);
    assert.equal(manualRetry.retryErrors, null);

    const available = store.enqueuePlan('fixture-snapshot', { timestamp: 6_000, runPolicy: policy });
    assert.equal(store.claimRun(available.id, ['source:fixture-main'], 6_000, manager), true);
    const published = store.finishRun(available.id, {
      success: true,
      receipt: { ok: true, status: 'published', data: { checked: true } },
      exitCode: 0,
    }, 7_000, manager);
    assert.equal(published.status, 'succeeded');
    assert.equal(published.attempt, 1);
    assert.equal(published.runAfter, 6_000);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema 4 databases migrate polling-window policy columns and plugin state to schema 6', () => {
  const { root, paths } = fixture();
  let store = new CollectionStore(paths);
  try {
    store.close();
    const legacy = new DatabaseSync(paths.database);
    legacy.exec(`
      ALTER TABLE runs DROP COLUMN retryable_errors_json;
      ALTER TABLE runs DROP COLUMN retry_deadline;
      PRAGMA user_version=4;
    `);
    legacy.close();
    store = new CollectionStore(paths);
    assert.equal(store.health().schemaVersion, 6);
    const columns = store.db.prepare('PRAGMA table_info(runs)').all().map(column => column.name);
    assert.equal(columns.includes('retry_deadline'), true);
    assert.equal(columns.includes('retryable_errors_json'), true);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
