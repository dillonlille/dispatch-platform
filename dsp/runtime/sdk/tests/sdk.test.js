'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { success, failure, isResult } = require('dispatch-protocol/contracts/src');
const { AuthClient } = require('../src/auth-client');
const { CollectionClient } = require('dispatch-runtime-kit/sdk/src/collection-client');
const { SyncClient } = require('dispatch-runtime-kit/sdk/src/sync-client');
const { PaycomClient } = require('../src/paycom-client');
const { LocalCollectionManagerPort } = require('../../adapters/local/collection-manager-port');
const { LocalPaycomPublicationPort } = require('../../../plugins/paycom/backend/adapters/publication');
const { getSystemStatus } = require('../../application/system/get-status');
const publicSdk = require('../src');

const COLLECTION_HEALTH = {
  schemaVersion: 1,
  databaseIntegrity: 'ok',
  manager: { running: false, pid: null, heartbeatAt: null },
  counts: { collectors: 1, sources: 1, plans: 7, queued: 0, running: 0, failed: 0 },
  syncAlerts: { total: 0, critical: 0, items: [], hasMore: false },
};
const PAYCOM_HEALTH = {
  database: 'ready',
  storageStatus: 'ready',
  publicationStatus: 'degraded',
  ready: false,
  payPeriods: { verified: true, code: 'verified', kind: 'pay_periods', target: '2026-08-25', rowCount: 3, collectedAt: '2026-08-25T00:00:00.000Z', projectionValid: true },
  roster: { verified: false, code: 'not_loaded', kind: 'roster', target: null },
  timecards: { verified: false, code: 'not_loaded', kind: 'timecards', target: null },
  resourceLinks: { verified: false, code: 'not_loaded', kind: 'resource_links', target: null },
};
function run(id = 'run_fixture_1') {
  return {
    id, plan: 'paycom-roster', source: 'paycom-main', collector: 'paycom', method: 'roster.snapshot',
    trigger: 'manual', logicalKey: 'sdk:paycom-roster:button-click-1', status: 'queued', attempt: 0,
    maxAttempts: 2, runAfter: 1, startedAt: null, finishedAt: null, error: null, blocked: null,
    attempts: [], attemptHistoryComplete: true,
    cancelRequested: false, collectorVersion: '0.3.0',
  };
}

test('SDK root exposes only the deliberate public surface', () => {
  assert.deepEqual(Object.keys(publicSdk).sort(), [
    'AuthClient', 'AuthSetupWorkflowClient', 'ConnectionsClient', 'CollectionAdminClient', 'CollectionClient', 'DispatchClient', 'PaycomClient',
    'SyncClient', 'SystemClient', 'WorkforceClient', 'contracts', 'createLocalDispatchClient', 'resolveLocalRuntimePaths',
  ].sort());
  assert.equal(Object.hasOwn(publicSdk, 'SAFE_CODES'), false);
  assert.equal(Object.hasOwn(publicSdk, 'RecordingEventSink'), false);
  assert.equal(Object.hasOwn(publicSdk.contracts, 'jsonValue'), false);
  assert.equal(Object.isFrozen(publicSdk), true);
  assert.equal(Object.isFrozen(publicSdk.contracts), true);
});

test('local runtime roots are explicit, absolute, and source-tree independent', () => {
  const roots = publicSdk.resolveLocalRuntimePaths({
    projectRoot: '/opt/dispatch', dataRoot: '/var/lib/dispatch', stateRoot: '/var/lib/dispatch-state',
    secretsRoot: '/etc/dispatch-secrets', runtimeRoot: '/run/user/1000/dispatch',
    stagingRoot: '/var/lib/dispatch-state/staging',
  });
  assert.equal(roots.auth.database, '/var/lib/dispatch/auth-broker/credentials.sqlite3');
  assert.equal(roots.auth.key, '/etc/dispatch-secrets/auth-broker/master.key');
  assert.equal(roots.auth.socket, '/run/user/1000/dispatch/auth-broker.sock');
  assert.equal(roots.collection.database, '/var/lib/dispatch/collection-manager/collection-manager.sqlite3');
  assert.equal(roots.accessControl.database, '/var/lib/dispatch/access-control/access-control.sqlite3');
  assert.equal(roots.cdf.database, '/var/lib/dispatch/db/cdf/cdf.sqlite3');
  assert.equal(roots.paycom.collectorCommand, path.join('/opt/dispatch', 'plugins/paycom/backend/bin/dispatch-paycom-collector'));
  assert.throws(() => publicSdk.resolveLocalRuntimePaths({ dataRoot: 'relative' }), error => error.code === 'unsafe_runtime_config');
  assert.throws(() => publicSdk.resolveLocalRuntimePaths({
    projectRoot: '/opt/dispatch', dataRoot: '/opt/dispatch/db',
  }), error => error.code === 'unsafe_runtime_config');
  assert.throws(() => publicSdk.resolveLocalRuntimePaths({
    projectRoot: '/opt/dispatch', dataRoot: path.join(__dirname, "../../../unsafe-data"),
  }), error => error.code === 'unsafe_runtime_config');
  assert.throws(() => publicSdk.resolveLocalRuntimePaths({
    dataRoot: '/var/lib/dispatch', secretsRoot: '/var/lib/dispatch/secrets',
  }), error => error.code === 'unsafe_runtime_config');
  assert.throws(() => publicSdk.resolveLocalRuntimePaths({ unknown: '/tmp/value' }), error => error.code === 'unsafe_runtime_config');
});

test('one external local root derives the development storage layout', () => {
  const roots = publicSdk.resolveLocalRuntimePaths({ projectRoot: '/opt/dispatch', localRoot: '/srv/dispatch-local' });
  assert.equal(roots.dataRoot, '/srv/dispatch-local/data');
  assert.equal(roots.auth.key, '/srv/dispatch-local/secrets/auth-broker/master.key');
  assert.equal(roots.auth.browserSessions, '/srv/dispatch-local/state/auth-broker/browser-sessions');
  assert.equal(roots.auth.socket, '/srv/dispatch-local/run/auth-broker.sock');
  assert.equal(roots.paycom.stagingRoot, '/srv/dispatch-local/staging/plugins/paycom');
});

test('explicit runtime roots and provider imports work without a Linux home directory', () => {
  const sourceRoot = path.resolve(__dirname, "../../..");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key !== 'HOME' && !key.startsWith('XDG_') && !key.startsWith('DISPATCH_')));
  for (const configuredRoots of [
    { DISPATCH_LOCAL_ROOT: '/srv/dispatch-fixture' },
    { DISPATCH_DATA_ROOT: '/srv/dispatch-fixture/data', DISPATCH_SECRETS_ROOT: '/srv/dispatch-fixture/secrets',
      DISPATCH_STATE_ROOT: '/srv/dispatch-fixture/state', DISPATCH_RUNTIME_ROOT: '/srv/dispatch-fixture/run',
      DISPATCH_STAGING_ROOT: '/srv/dispatch-fixture/staging' },
  ]) {
    const result = spawnSync(process.execPath, ['--no-warnings', '-e', `
      require('node:os').homedir = () => { throw new Error('no_passwd_entry'); };
      const roots = require('dispatch-protocol/paths/runtime-paths').resolveLocalRuntimePaths();
      const provider = require('./plugins/paycom/backend/src/paths');
      require('./plugins/paycom/backend/src/collector');
      process.stdout.write(JSON.stringify({ data: roots.dataRoot, database: provider.DATABASE }));
    `], { cwd: sourceRoot, env: { ...environment, ...configuredRoots }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      data: '/srv/dispatch-fixture/data', database: '/srv/dispatch-fixture/data/db/paycom/paycom.sqlite3',
    });
  }
});

test('runtime roots reject symlink aliases into the source worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-runtime-boundary-'));
  fs.chmodSync(root, 0o700);
  const alias = path.join(root, 'worktree-alias');
  fs.symlinkSync(path.resolve(__dirname, "../../.."), alias, 'dir');
  try {
    assert.throws(() => publicSdk.resolveLocalRuntimePaths({
      dataRoot: path.join(alias, 'data'),
    }), error => error.code === 'unsafe_runtime_config');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit Auth state override does not relocate its runtime socket', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-paths-'));
  fs.chmodSync(root, 0o700);
  try {
    const stateRoot = path.join(root, 'state');
    const paths = require('../../auth-broker/src/paths').defaultPaths({ stateRoot });
    const resolved = publicSdk.resolveLocalRuntimePaths();
    assert.equal(paths.stateRoot, stateRoot);
    assert.equal(paths.runtimeRoot, resolved.auth.runtimeRoot);
    assert.equal(path.dirname(paths.socket), resolved.auth.runtimeRoot);
    assert.notEqual(paths.runtimeRoot, paths.stateRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('component-specific runtime overrides cannot bypass the worktree boundary', () => {
  const projectRoot = path.resolve(__dirname, "../../..");
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('DISPATCH_')),
  );
  const cases = [
    ['runtime/auth-broker/src/paths.js', 'defaultPaths', 'DISPATCH_AUTH_DATABASE_ROOT'],
    ['runtime/auth-broker/src/paths.js', 'defaultPaths', 'DISPATCH_AUTH_SECRET_ROOT'],
    ['runtime/auth-broker/src/paths.js', 'defaultPaths', 'DISPATCH_AUTH_STATE_ROOT'],
    ['runtime/auth-broker/src/paths.js', 'defaultPaths', 'DISPATCH_AUTH_SOCKET'],
    ['runtime/collection-manager/src/paths.js', 'defaultPaths', 'DISPATCH_COLLECTION_DATABASE_ROOT'],
    ['runtime/collection-manager/src/paths.js', 'defaultPaths', 'DISPATCH_COLLECTION_STATE_ROOT'],
    ['plugins/paycom/backend/src/paths.js', null, 'DISPATCH_PAYCOM_DATA_ROOT'],
    ['plugins/paycom/backend/src/paths.js', null, 'DISPATCH_PAYCOM_STAGING_ROOT'],
    ['plugins/paycom/backend/src/paths.js', null, 'DISPATCH_AUTH_SOCKET'],
    ['compatibility/cdf/src/paths.js', null, 'DISPATCH_CDF_DATA_ROOT'],
    ['compatibility/cdf/src/paths.js', null, 'DISPATCH_CDF_STAGING_ROOT'],
  ];
  for (const [relativeModule, method, environmentName] of cases) {
    const modulePath = path.join(projectRoot, relativeModule);
    const invocation = method
      ? `require(${JSON.stringify(modulePath)}).${method}()`
      : `require(${JSON.stringify(modulePath)})`;
    const child = spawnSync(process.execPath, ['--no-warnings', '-e', invocation], {
      encoding: 'utf8',
      env: { ...baseEnvironment, [environmentName]: path.join(projectRoot, `unsafe-${environmentName.toLowerCase()}`) },
    });
    assert.notEqual(child.status, 0, `${relativeModule} accepted ${environmentName} inside the worktree`);
    assert.match(`${child.stdout}${child.stderr}`, /unsafe_runtime_config/);
  }
});

test('capability discovery is explicit and collection administration is opt-in', async () => {
  const admin = new publicSdk.CollectionAdminClient({ port: {
    inspect: async () => ({ initialized: false, schemaVersion: null, counts: { collectors: 0, sources: 0, plans: 0, syncs: 0 } }),
    initialize: async () => ({ initialized: true, schemaVersion: 1, counts: { collectors: 0, sources: 0, plans: 0, syncs: 0 } }),
    preview: async () => ({
      valid: true, incoming: { collectors: 1, sources: 1, plans: 1, syncs: 0 },
      changes: {
        collectors: { create: 1, update: 0 }, sources: { create: 1, update: 0 },
        plans: { create: 1, update: 0 }, syncs: { create: 0, update: 0 },
      },
    }),
    apply: async () => ({ collectors: 1, sources: 1, plans: 1, syncs: 0 }),
  } });
  const inert = {};
  const dispatch = new publicSdk.DispatchClient({
    auth: inert, collections: inert, sync: inert, paycom: inert, workforce: inert, authSetup: inert,
    collectionAdmin: admin, transport: 'local',
  });
  const capabilities = dispatch.capabilities();
  assert.equal(capabilities.data.transport, 'local');
  assert.equal(capabilities.data.operator.collectionAdmin, true);
  assert.equal((await admin.inspect()).status, 'not_initialized');
  assert.equal((await admin.initialize()).status, 'initialized');
});

test('AuthClient maps broker metadata without exposing transport or raw responses', async () => {
  const calls = [];
  const options = [];
  const client = new AuthClient({ port: { request: async (payload, requestOptions) => {
    calls.push(payload);
    options.push(requestOptions);
    if (payload.action === 'health') return { ok: true, status: 'ready', protocolVersion: 5, vault: { verified: true, profiles: 1, schemaVersion: 1 }, ignored: 'not forwarded' };
    if (payload.action === 'inspect-auth-profile') return {
      ok: true, status: 'inspected', inspection: {
        profile: payload.profile, provider: 'paycom', state: 'security_profile_prompt', observedAt: '2026-08-25T22:59:00.000Z',
        metadata: {
          origin: 'https://www.paycomonline.net', path: '/v4/cl/web.php/security-profile', queryKeys: [], title: 'Setup Your Security Profile',
          readyState: 'complete', loginFormCount: 0, challengeFormCount: 0,
          profileInputNames: [], profileActionLabels: ['Not Now'], challengeIndices: [], challengeFormActionPath: null, diagnostic: null,
        },
      }, ignored: 'not forwarded',
    };
    if (payload.action === 'test-auth-profile') return { ok: true, status: 'authenticated', profile: { profile: payload.profile, provider: 'paycom', testedAt: '2026-08-25T23:00:00.000Z' }, ignored: 'not forwarded' };
    return { ok: true, status: 'configured', profile: { configured: true, profile: payload.profile, provider: 'paycom', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' }, session: 'not_started', endpoint: 'not-forwarded' };
  } } });
  const health = await client.health();
  const profile = await client.profileStatus('paycom-main');
  const inspected = await client.inspectProfile('paycom-main');
  const tested = await client.testProfile('paycom-main');
  assert.equal(Object.hasOwn(client, 'port'), false);
  assert.deepEqual(health.data, { protocolVersion: 5, vault: { verified: true, profiles: 1, schemaVersion: 1 } });
  assert.equal(JSON.stringify(health).includes('ignored'), false);
  assert.equal(JSON.stringify(profile).includes('endpoint'), false);
  assert.equal(profile.data.profile.provider, 'paycom');
  assert.equal(inspected.data.state, 'security_profile_prompt');
  assert.deepEqual(inspected.data.metadata.profileActionLabels, ['Not Now']);
  assert.equal(JSON.stringify(inspected).includes('ignored'), false);
  assert.deepEqual(tested.data, { profile: 'paycom-main', provider: 'paycom', testedAt: '2026-08-25T23:00:00.000Z' });
  assert.equal(JSON.stringify(tested).includes('endpoint'), false);
  assert.equal(JSON.stringify(tested).includes('lease'), false);
  assert.deepEqual(calls.map(value => value.action), ['health', 'status', 'inspect-auth-profile', 'test-auth-profile']);
  const authDeadline = require('dispatch-protocol/browser-assistance/protocol').AUTH_REQUEST_MS;
  assert.equal(options[2].timeoutMs, authDeadline + 10_000);
  assert.equal(options[3].timeoutMs, authDeadline + 10_000);
});

test('AuthClient returns stable failures for transport and malformed component responses', async () => {
  const client = new AuthClient({ port: { request: async () => { throw new Error('fixture transport details'); } } });
  const result = await client.health();
  assert.equal(result.status, 'auth_broker_unavailable');
  assert.equal(result.error.recoverable, true);
  assert.equal(JSON.stringify(result).includes('fixture transport details'), false);
  const malformed = new AuthClient({ port: { request: async () => ({ ok: true, status: 'ready', protocolVersion: 5, vault: { verified: true } }) } });
  assert.equal((await malformed.health()).status, 'invalid_component_response');
  assert.equal((await malformed.profileStatus('BAD PROFILE')).status, 'invalid_input');

  const cleanup = new AuthClient({ port: { request: async () => ({
    ok: true, status: 'configured',
    profile: { configured: true, profile: 'paycom-main', provider: 'paycom', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
    session: 'cleanup_failed',
  }) } });
  assert.equal((await cleanup.profileStatus('paycom-main')).data.session, 'cleanup_failed');

  const wrongStatus = new AuthClient({ port: { request: async () => ({
    ok: true, status: 'unexpected_success', protocolVersion: 5,
    vault: { verified: true, profiles: 1, schemaVersion: 1 },
  }) } });
  assert.equal((await wrongStatus.health()).status, 'invalid_component_response');

  for (const code of ['mfa_required', 'captcha_required', 'security_challenge']) {
    const challenge = new AuthClient({ port: { request: async () => ({ ok: false, status: code }) } });
    const result = await challenge.testProfile('amazon-operations');
    assert.equal(result.status, code);
    assert.equal(result.error.recoverable, true);
  }
});

test('CollectionClient returns closed view models and propagates a durable idempotency key', async () => {
  const runsByKey = new Map();
  const enqueued = [];
  const port = {
    health: async () => ({ ok: true, status: 'stopped', ...COLLECTION_HEALTH }),
    collectors: async () => [
      { id: 'a', version: '1.0.0', description: 'A', command: '/private/a', sourceSchema: {}, enabled: true, updatedAt: 1 },
      { id: 'b', version: '1.0.0', description: 'B', command: '/private/b', sourceSchema: {}, enabled: true, updatedAt: 2 },
    ],
    startRun: async (_plan, _input, logicalKey) => {
      if (runsByKey.has(logicalKey)) return runsByKey.get(logicalKey);
      const value = run(`run_fixture_${enqueued.length + 1}`);
      value.logicalKey = logicalKey;
      enqueued.push(value);
      runsByKey.set(logicalKey, value);
      return value;
    },
  };
  const client = new CollectionClient({ port });
  const result = await client.collectors({ limit: 1, offset: 1 });
  assert.deepEqual(result.data.items[0], { id: 'b', version: '1.0.0', description: 'B', enabled: true, updatedAt: '1970-01-01T00:00:00.002Z' });
  assert.equal(JSON.stringify(result).includes('/private/b'), false);
  assert.equal((await client.collectors({ limit: 1, extra: true })).status, 'invalid_input');
  const first = await client.startRun('paycom-roster', {}, { idempotencyKey: 'button-click-1' });
  const second = await client.startRun('paycom-roster', {}, { idempotencyKey: 'button-click-1' });
  assert.equal(first.data.id, second.data.id);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].logicalKey, 'sdk:paycom-roster:button-click-1');
  assert.equal((await client.startRun('paycom-roster', { passwordHash: 'blocked' })).status, 'invalid_input');
});

test('CollectionClient exposes a bounded run receipt summary without publication internals', async () => {
  const detailed = {
    ...run('run_receipt_fixture'), status: 'succeeded', attempt: 1, startedAt: 2, finishedAt: 3,
    attempts: [{ attempt: 1, status: 'succeeded', category: 'success', startedAt: 2, finishedAt: 3, error: null, exitCode: 0 }],
    receipt: {
      ok: true, status: 'published',
      data: { rowCount: 12, checked: true, publicationId: 'private-publication', contentSha256: 'private-hash' },
      warnings: ['fixture warning'],
    },
  };
  const client = new CollectionClient({ port: {
    health: async () => ({ ok: true, status: 'stopped', ...COLLECTION_HEALTH }),
    run: async () => detailed,
  } });
  const result = await client.runStatus(detailed.id);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.data.receipt.metrics, { rowCount: 12, checked: true });
  assert.equal(JSON.stringify(result).includes('private-publication'), false);
  assert.equal(JSON.stringify(result).includes('private-hash'), false);
});

test('CollectionClient exposes standard preview, batch, and schedule operations without private task input', async () => {
  const batchSummary = {
    id: 'batch_fixture', source: 'paycom-main', scope: 'full',
    request: { source: 'paycom-main', scope: 'full', selector: { kind: 'date', date: '2026-08-18' }, mode: 'ensure' },
    previewHash: 'a'.repeat(64), logicalKey: null, status: 'queued',
    counts: { queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0 }, runCount: 1,
    createdAt: 1,
  };
  const batch = {
    ...batchSummary,
    runPage: { items: [{ targetKey: '2026-08-22', taskId: 'roster', run: run() }], total: 1, limit: 50, offset: 0, hasMore: false },
  };
  const schedule = {
    id: 'cdf-weekly-window', request: batch.request,
    schedule: {
      type: 'polling-window', expression: '0 15 * * 2', timezone: 'America/Los_Angeles',
      intervalSeconds: 900, windowSeconds: 86_400, retryErrors: ['week_unavailable'],
    },
    enabled: true, nextDueAt: null, createdAt: 1, updatedAt: 1,
  };
  const port = {
    health: async () => ({ ok: true, status: 'stopped', ...COLLECTION_HEALTH }),
    describeCollection: async () => ({
      source: 'paycom-main', collector: 'paycom', collectorVersion: '0.6.0', targetType: 'pay-period',
      timezone: 'America/Los_Angeles', selectors: ['date'], scopes: [{ id: 'full', description: 'Everything', taskCount: 4, auditSupported: true, auditTaskCount: 1 }],
      limits: { maxTargets: 64, maxRangeDays: 730 }, privateTasks: ['not exposed'],
    }),
    previewCollection: async request => ({
      id: 'preview_fixture', hash: 'a'.repeat(64), generatedAt: '2026-08-26T00:00:00.000Z',
      request, normalizedSelector: request.selector, source: request.source, collector: 'paycom', collectorVersion: '0.6.0',
      targetType: 'pay-period', timezone: 'America/Los_Angeles', targetCount: 1, taskCount: 1,
      targets: [{ key: '2026-08-22', start: '2026-08-09', end: '2026-08-22', values: { periodEnd: 'private' } }],
      tasks: [{ targetKey: '2026-08-22', taskId: 'roster', plan: 'paycom-period-roster', input: { private: true }, dependsOn: [] }],
    }),
    enqueueCollection: async () => batch,
    batches: async () => ({ items: [batchSummary], total: 1 }), batch: async () => batch,
    cancelBatch: async () => ({ ...batch, status: 'cancelled', counts: { ...batch.counts, queued: 0, cancelled: 1 } }),
    retryBatch: async () => batch,
    collectionSchedules: async () => [schedule], putCollectionSchedule: async () => schedule,
    setCollectionScheduleEnabled: async (_id, enabled) => ({ ...schedule, enabled }), removeCollectionSchedule: async () => schedule,
    runCollectionSchedule: async () => batch,
  };
  const client = new CollectionClient({ port });
  const request = batch.request;
  const described = await client.describe('paycom-main');
  assert.equal(JSON.stringify(described).includes('privateTasks'), false);
  const previewed = await client.preview(request);
  assert.equal(previewed.status, 'previewed');
  assert.equal(JSON.stringify(previewed).includes('periodEnd'), false);
  assert.equal(JSON.stringify(previewed).includes('"private"'), false);
  assert.equal((await client.enqueue(request, { expectedPreviewHash: 'a'.repeat(64) })).data.id, 'batch_fixture');
  assert.equal((await client.batches()).data.total, 1);
  assert.equal((await client.batchStatus('batch_fixture')).status, 'queued');
  assert.equal((await client.cancelBatch('batch_fixture')).status, 'cancelled');
  assert.equal((await client.retryBatch('batch_fixture')).status, 'queued');
  assert.equal((await client.audit(request)).status, 'queued');
  assert.equal((await client.createSchedule({ id: schedule.id, request, schedule: schedule.schedule })).status, 'scheduled');
  assert.equal((await client.pauseSchedule(schedule.id)).data.enabled, false);
  assert.equal((await client.resumeSchedule(schedule.id)).data.enabled, true);
  assert.equal((await client.runScheduleNow(schedule.id)).status, 'queued');
  assert.equal((await client.removeSchedule(schedule.id)).status, 'removed');
});

test('SyncClient exposes closed lifecycle, edit, and history operations', async () => {
  const sync = {
    id: 'fixture-main-sync', plan: 'fixture-sync-plan', source: 'fixture-main', collector: 'fixture', method: 'fixture.sync',
    desiredState: 'stopped', activity: 'idle', intervalSeconds: 60, jitterSeconds: 5, overlap: 'coalesce',
    settingsSchema: { type: 'object', properties: { behavior: { type: 'string' } }, required: ['behavior'], additionalProperties: false },
    settings: { behavior: 'no_change' }, revision: 1, generation: 0, nextDueAt: null,
    lastStartedAt: null, lastSucceededAt: null, lastError: null, blocked: null,
    businessContext: { date: '2026-08-29', timezone: 'America/Los_Angeles' }, alerts: [],
    activeRun: null, queuedRunCount: 0, createdAt: 1, updatedAt: 1,
  };
  const queued = { ...run('run_sync_fixture'), plan: sync.plan, method: sync.method, trigger: 'sync_start' };
  const completed = {
    ...queued, status: 'succeeded', attempt: 2, startedAt: 10, finishedAt: 20,
    attempts: [
      { attempt: 1, status: 'failed', category: 'provider', startedAt: 2, finishedAt: 3, error: 'paycom_timeout', exitCode: 0 },
      { attempt: 2, status: 'succeeded', category: 'success', startedAt: 10, finishedAt: 20, error: null, exitCode: 0 },
    ],
    receipt: { ok: true, status: 'published', data: {
      businessDate: '2026-08-29', businessTimezone: 'America/Los_Angeles',
      delta: {
        roster: { addedCount: 0, profileChangedCount: 0, summaryChangedCount: 0, recordChangedCount: 0, becameUnknownCount: 0, returnedFromUnknownCount: 0 },
        timecards: { addedCount: 0, changedCount: 2, unchangedCount: 98, removedCount: 0 },
        days: { addedCount: 0, changedCount: 2, removedCount: 0, missingPunchAddedCount: 0, missingPunchResolvedCount: 1, unresolvedSlotAddedCount: 0, unresolvedSlotResolvedCount: 1, commentSectionsChangedCount: 0, totalSectionsChangedCount: 1 },
        punches: { addedCount: 7, editedCount: 0, removedCount: 0, kindChangedCount: 0, addedByKind: { inDayCount: 0, outLunchCount: 0, inLunchCount: 0, outDayCount: 7, unclassifiedCount: 0 }, removedByKind: { inDayCount: 0, outLunchCount: 0, inLunchCount: 0, outDayCount: 0, unclassifiedCount: 0 } },
        details: { additionalRowSectionsChangedCount: 0, approvalSectionsChangedCount: 1, attestationSectionsChangedCount: 0, mealWaiverSectionsChangedCount: 0 },
      },
      persistence: { verified: true, code: 'verified', date: '2026-08-29', timecardCount: 100, dateRowCount: 100, selectedTimecardCount: 100, persistedSelectedTimecardCount: 100, selectedMismatchCount: 0, punchCount: 117, inDayPunchCount: 38, inDayTimecardCount: 38, outLunchPunchCount: 37, inLunchPunchCount: 35, outDayPunchCount: 7, unclassifiedPunchCount: 0 },
    } },
  };
  const port = {
    syncs: async () => ({ items: [sync], total: 1 }),
    sync: async () => sync,
    start: async () => ({ sync: { ...sync, desiredState: 'running', activity: 'queued', generation: 1, activeRun: queued, queuedRunCount: 1 }, run: queued }),
    stop: async () => sync,
    restart: async () => ({ sync: { ...sync, desiredState: 'running', activity: 'queued', generation: 2, activeRun: queued, queuedRunCount: 1 }, run: queued }),
    runNow: async () => ({ sync: { ...sync, desiredState: 'running', activity: 'queued', activeRun: queued, queuedRunCount: 1 }, run: queued }),
    edit: async (_id, patch) => ({ sync: { ...sync, ...patch, revision: 2 }, run: null }),
    history: async () => ({ items: [{ generation: 1, configRevision: 1, windowKey: 'start:1', trigger: 'sync_start', run: completed }], total: 1, limit: 50, offset: 0, hasMore: false }),
  };
  const client = new SyncClient({ port });
  assert.equal((await client.list()).data.total, 1);
  const status = await client.status(sync.id);
  assert.equal(status.data.settings.behavior, 'no_change');
  assert.deepEqual(status.data.businessContext, { date: '2026-08-29', timezone: 'America/Los_Angeles' });
  assert.deepEqual(status.data.alerts, []);
  assert.equal((await client.start(sync.id)).status, 'started');
  assert.equal((await client.edit(sync.id, { intervalSeconds: 120 }, { expectedRevision: 1 })).data.sync.revision, 2);
  assert.equal((await client.restart(sync.id)).status, 'restarted');
  assert.equal((await client.runNow(sync.id)).status, 'queued');
  const history = await client.history(sync.id);
  assert.equal(history.data.items[0].run.id, queued.id);
  assert.equal(history.data.items[0].businessContext.date, '2026-08-29');
  assert.equal(history.data.items[0].delta.punches.addedByKind.outDayCount, 7);
  assert.equal(history.data.items[0].delta.details.approvalSectionsChangedCount, 1);
  assert.equal(history.data.items[0].persistence.selectedMismatchCount, 0);
  assert.equal(history.data.items[0].run.attempts[0].error, 'paycom_timeout');
  assert.equal((await client.stop(sync.id)).status, 'stopped');
  assert.equal((await client.edit(sync.id, {})).status, 'invalid_input');
});

test('local Collection Manager port uses read-only queries and always closes stores', () => {
  const options = [];
  let closed = 0;
  const store = {
    health: () => ({ ok: true, status: 'stopped', ...COLLECTION_HEALTH }),
    collectors: () => [],
    close: () => { closed += 1; },
  };
  const port = new LocalCollectionManagerPort({
    paths: { database: __filename },
    storeFactory: (_paths, value) => { options.push(value); return store; },
  });
  assert.equal(port.health().status, 'stopped');
  assert.deepEqual(port.collectors(), []);
  assert.deepEqual(options, [{ readOnly: true }, { readOnly: true }]);
  assert.equal(closed, 2);

  const missingDatabase = `/tmp/dispatch-sdk-uninitialized-${process.pid}.sqlite3`;
  const missingManager = new LocalCollectionManagerPort({ paths: { database: missingDatabase } });
  const missingPaycom = new LocalPaycomPublicationPort({ database: missingDatabase });
  assert.equal(missingManager.health().status, 'not_initialized');
  assert.equal(missingPaycom.health(), null);
  assert.equal(fs.existsSync(missingDatabase), false);
});

test('PaycomClient returns a closed publication-health DTO and does not initialize missing storage', async () => {
  const missing = new PaycomClient({ port: { health: async () => null } });
  assert.equal((await missing.health()).status, 'not_initialized');
  const client = new PaycomClient({ port: { health: async () => ({
    payPeriods: { ...PAYCOM_HEALTH.payPeriods, publicationId: 'private', contentSha256: 'private', quickCheck: 'ok' },
    roster: PAYCOM_HEALTH.roster,
    timecards: PAYCOM_HEALTH.timecards,
    resourceLinks: PAYCOM_HEALTH.resourceLinks,
  }) } });
  const result = await client.health();
  assert.equal(result.status, 'degraded');
  assert.equal(result.data.ready, false);
  assert.equal(result.data.storageStatus, 'ready');
  assert.equal(JSON.stringify(result).includes('publicationId'), false);
  assert.equal(JSON.stringify(result).includes('contentSha256'), false);
});

test('system status validates component DTOs and sanitizes rejected or malicious results', async () => {
  const result = await getSystemStatus({
    auth: { health: async () => failure('auth_broker_unavailable', { recoverable: true }) },
    collections: { health: async () => success('stopped', COLLECTION_HEALTH) },
    paycom: { health: async () => success('degraded', PAYCOM_HEALTH) },
  });
  assert.equal(isResult(result), true);
  assert.equal(result.status, 'degraded');
  assert.equal(result.data.components.auth.status, 'stopped');
  assert.deepEqual(result.data.summary, { ready: 0, degraded: 2, failed: 0 });

  const failed = await getSystemStatus({
    auth: { health: async () => { throw new Error('private fixture detail'); } },
    collections: { health: async () => success('ready', COLLECTION_HEALTH) },
    paycom: { health: async () => ({ contractVersion: 1, ok: true, status: 'ready', data: { password: 'fixture' } }) },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.data.components.auth.error.code, 'auth_client_failed');
  assert.equal(failed.data.components.paycom.error.code, 'invalid_component_response');
  assert.equal(JSON.stringify(failed).includes('private fixture detail'), false);
  assert.equal(JSON.stringify(failed).includes('fixture'), false);
});

test('component DTO defects remain invalid responses rather than availability failures', async () => {
  const collections = new CollectionClient({ port: { health: async () => ({ ok: true, status: 'ready', manager: {}, counts: {} }) } });
  assert.equal((await collections.health()).status, 'invalid_component_response');

  const sync = new SyncClient({ port: { syncs: async () => ({ items: [{}], total: 1 }) } });
  assert.equal((await sync.list()).status, 'invalid_component_response');

  const paycom = new PaycomClient({ port: { health: async () => ({ payPeriods: {}, roster: {}, timecards: {} }) } });
  assert.equal((await paycom.health()).status, 'invalid_component_response');
});
