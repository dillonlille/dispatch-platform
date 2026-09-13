'use strict';

const path = require('node:path');
const {
  isResult,
  serverInstallationManifest,
} = require('dispatch-protocol/contracts/src');
const {
  managedPaycomDefinition,
  managedPaycomFirstPublicationRequest,
  PAYCOM_FIRST_PUBLICATION_TASKS,
  PAYCOM_PROFILE_ID,
  PAYCOM_SYNC_ID,
} = require('./paycom-definition');

const DEFAULT_PUBLICATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PUBLICATION_POLL_MS = 1000;
const MAX_PAY_PERIOD_PREPARATION_MS = 5 * 60 * 1000;
const PAYCOM_PERIODS_PLAN = 'paycom-periods';
const EXPECTED_FIRST_PUBLICATION_PLANS = Object.freeze(Object.fromEntries(
  Object.entries(PAYCOM_FIRST_PUBLICATION_TASKS).map(([plan, definition]) => [plan, definition.method]),
));

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, fields, code = 'runtime_boundary_violation') {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail(code);
  return value;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function successful(result, statuses, code) {
  if (!isResult(result) || !result.ok || !statuses.includes(result.status)) fail(code);
  return result;
}

function createManagedPaycomActivationRuntime(options) {
  const optionFields = [
    'manifest', 'manifestAuthority', 'layout', 'serviceManager', 'supervisor', 'client',
    'collectionAdmin', 'gateway', 'evidenceVerifier', 'clock', 'delay', 'publicationTimeoutMs', 'publicationPollMs',
    'projectRoot', 'infrastructureVerifier',
  ];
  if (!plain(options) || Object.keys(options).some(key => !optionFields.includes(key))
      || !['manifest', 'manifestAuthority', 'client',
        'collectionAdmin', 'gateway', 'evidenceVerifier'].every(key => Object.hasOwn(options, key))) {
    fail('runtime_boundary_violation');
  }
  const manifest = serverInstallationManifest(options.manifest, options.manifestAuthority);
  const layout = options.layout;
  const serviceManager = options.serviceManager;
  const supervisor = options.supervisor;
  const client = options.client;
  const collectionAdmin = options.collectionAdmin;
  const gateway = options.gateway;
  const evidenceVerifier = options.evidenceVerifier;
  if ((typeof options.infrastructureVerifier !== 'function' && (!layout || typeof layout.inspect !== 'function'
      || !serviceManager || typeof serviceManager.plan !== 'function' || typeof serviceManager.inspectInstalled !== 'function'
      || !supervisor || typeof supervisor.inspect !== 'function' || typeof supervisor.health !== 'function'))
      || !client?.auth || !client?.collections || !client?.sync || !client?.paycom
      || !collectionAdmin || !['preview', 'apply', 'inspect', 'attest']
        .every(method => typeof collectionAdmin[method] === 'function')
      || !gateway || typeof gateway.health !== 'function'
      || !evidenceVerifier || typeof evidenceVerifier.verify !== 'function') fail('runtime_boundary_violation');
  const clock = options.clock === undefined ? Date.now : options.clock;
  const delay = options.delay === undefined ? ms => new Promise(resolve => setTimeout(resolve, ms)) : options.delay;
  const publicationTimeoutMs = options.publicationTimeoutMs === undefined
    ? DEFAULT_PUBLICATION_TIMEOUT_MS : options.publicationTimeoutMs;
  const publicationPollMs = options.publicationPollMs === undefined
    ? DEFAULT_PUBLICATION_POLL_MS : options.publicationPollMs;
  if (typeof clock !== 'function' || typeof delay !== 'function'
      || !Number.isSafeInteger(publicationTimeoutMs) || publicationTimeoutMs < 1000 || publicationTimeoutMs > DEFAULT_PUBLICATION_TIMEOUT_MS
      || !Number.isSafeInteger(publicationPollMs) || publicationPollMs < 10 || publicationPollMs > 10_000) {
    fail('runtime_boundary_violation');
  }
  const projectRoot = options.projectRoot;
  const definitionOptions = projectRoot === undefined ? {} : { projectRoot };
  const expectedDefinition = () => managedPaycomDefinition(manifest, options.manifestAuthority, definitionOptions);

  function selectedManifest(value) {
    const selected = serverInstallationManifest(value, options.manifestAuthority);
    if (!same(selected, manifest)) fail('runtime_identity_mismatch');
    return selected;
  }

  async function verifyInfrastructure(manifestValue) {
    const selected = selectedManifest(manifestValue);
    if (options.infrastructureVerifier) return options.infrastructureVerifier(selected);
    const selectedLayout = layout.inspect(selected, options.manifestAuthority);
    const plan = serviceManager.plan(selected, options.manifestAuthority, selectedLayout);
    serviceManager.inspectInstalled(plan);
    supervisor.inspect(plan);
    supervisor.health(plan);
    const auth = successful(await client.auth.health(), ['ready'], 'runtime_health_failed');
    const collections = successful(await client.collections.health(), ['ready'], 'runtime_health_failed');
    if (auth.data?.vault?.verified !== true || collections.data?.manager?.running !== true
        || collections.data?.databaseIntegrity !== 'ok'
        || collections.data?.syncAlerts?.critical !== 0) fail('runtime_health_failed');
    const gatewayHealth = successful(await gateway.health(), ['ready'], 'runtime_health_failed');
    if (gatewayHealth.data?.runtimeIdentity !== 'matched') fail('runtime_identity_mismatch');
    return Object.freeze({
      runtimeKey: manifest.runtime.key,
      runtime_layout: true,
      service_supervision: true,
      auth_broker: true,
      collection_manager: true,
      runtime_gateway: true,
    });
  }

  async function configure(definition) {
    const expected = expectedDefinition();
    if (!definition || definition.digest !== expected.digest
        || !same(definition.specification, expected.specification)) fail('runtime_boundary_violation');
    const preview = collectionAdmin.preview(expected.specification);
    if (!plain(preview) || preview.valid !== true) fail('runtime_health_failed');
    const applied = collectionAdmin.apply(expected.specification);
    const expectedCounts = { collectors: 1, sources: 1, plans: 15, syncs: 1 };
    if (!same(applied, expectedCounts)) fail('runtime_health_failed');
    const inspected = collectionAdmin.inspect();
    if (inspected?.initialized !== true || !same(inspected.counts, expectedCounts)) fail('runtime_health_failed');
    const attested = collectionAdmin.attest(expected.specification);
    if (!plain(attested) || Object.keys(attested).length !== 1 || attested.matched !== true) {
      fail('runtime_health_failed');
    }
    const [source, sync] = await Promise.all([
      client.collections.source('paycom-main'),
      client.sync.status('paycom-main-workforce'),
    ]);
    successful(source, ['found'], 'runtime_health_failed');
    successful(sync, ['found'], 'runtime_health_failed');
    if (source.data?.authProfile !== PAYCOM_PROFILE_ID || sync.data?.desiredState !== 'stopped') {
      fail('runtime_health_failed');
    }
    return Object.freeze({ digest: expected.digest, ...expectedCounts });
  }

  async function startWorkforceSync() {
    const expected = expectedDefinition();
    let current = await client.sync.status(PAYCOM_SYNC_ID);
    if (!current.ok && current.status === 'sync_not_found') {
      await configure(expected);
      current = await client.sync.status(PAYCOM_SYNC_ID);
    }
    successful(current, ['found'], 'runtime_health_failed');
    if (!['running', 'stopped'].includes(current.data?.desiredState)) fail('runtime_health_failed');
    // Reconnection must not reapply definitions or reset an existing hourly window.
    const spec = structuredClone(expected.specification);
    const sync = spec.syncs.find(item => item.id === PAYCOM_SYNC_ID);
    sync.desiredState = current.data.desiredState;
    sync.intervalSeconds = current.data.intervalSeconds;
    sync.jitterSeconds = current.data.jitterSeconds;
    if (collectionAdmin.attest(spec)?.matched !== true) fail('runtime_health_failed');
    if (current.data.intervalSeconds !== 3600 || current.data.jitterSeconds !== 0) {
      successful(await client.sync.edit(PAYCOM_SYNC_ID, { intervalSeconds: 3600, jitterSeconds: 0 }), ['updated'], 'runtime_health_failed');
    }
    successful(await client.sync.start(PAYCOM_SYNC_ID), ['started'], 'runtime_health_failed');
    return Object.freeze({ syncId: PAYCOM_SYNC_ID, intervalSeconds: 3600, desiredState: 'running' });
  }

  async function testProvider(profileId) {
    if (profileId !== PAYCOM_PROFILE_ID) fail('provider_auth_required');
    const status = successful(await client.auth.profileStatus(profileId), ['configured'], 'provider_auth_required');
    if (status.data?.profile?.configured !== true || status.data.profile.provider !== 'paycom') {
      fail('provider_auth_required');
    }
    const response = await client.auth.testProfile(profileId);
    if (!response?.ok) fail(require('dispatch-protocol/contracts/src/paycom-setup').setupFailure(response?.status));
    const tested = successful(response, ['authenticated'], 'provider_auth_required');
    if (tested.data?.profile !== profileId || tested.data?.provider !== 'paycom'
        || typeof tested.data?.testedAt !== 'string' || Number.isNaN(Date.parse(tested.data.testedAt))) {
      fail('provider_auth_required');
    }
    return Object.freeze({
      profileId,
      provider: 'paycom',
      status: 'authenticated',
      testedAt: tested.data.testedAt,
    });
  }

  async function batch(batchId) {
    return successful(await client.collections.batchStatus(batchId, { limit: 50, offset: 0 }),
      ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
  }

  function publicationFromBatch(result) {
    const value = result.data;
    if (!value || typeof value.id !== 'string' || !value.counts || value.runPage?.hasMore !== false
        || value.runCount !== value.runPage.total || value.runCount !== value.runPage.items.length
        || value.runCount !== Object.keys(EXPECTED_FIRST_PUBLICATION_PLANS).length) {
      fail('first_publication_failed');
    }
    const plans = value.runPage.items.map(item => item?.run?.plan).sort();
    if (!same(plans, Object.keys(EXPECTED_FIRST_PUBLICATION_PLANS).sort())
        || value.runPage.items.some(item => item?.run?.source !== 'paycom-main'
          || item.run.method !== EXPECTED_FIRST_PUBLICATION_PLANS[item.run.plan]
          || item.taskId !== PAYCOM_FIRST_PUBLICATION_TASKS[item.run.plan]?.taskId
          || item.targetKey !== value.runPage.items[0]?.targetKey)) fail('first_publication_failed');
    return Object.freeze({
      batchId: value.id,
      status: value.status,
      runCount: value.runCount,
      succeededRuns: value.counts.succeeded,
      failedRuns: value.counts.failed,
      cancelledRuns: value.counts.cancelled,
    });
  }

  async function cancelAndDrain(batchId) {
    let result;
    try {
      result = successful(await client.collections.cancelBatch(batchId, { limit: 50, offset: 0 }),
        ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
    } catch {
      fail('installation_operation_in_progress');
    }
    const deadline = clock() + Math.min(60_000, publicationTimeoutMs);
    while (['queued', 'running'].includes(result.status)) {
      if (clock() >= deadline) fail('installation_operation_in_progress');
      await delay(publicationPollMs);
      try { result = await batch(batchId); }
      catch { fail('installation_operation_in_progress'); }
    }
    return result;
  }

  async function cancelRunAndDrain(runId) {
    let result;
    try {
      result = successful(await client.collections.cancelRun(runId),
        ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
    } catch {
      fail('installation_operation_in_progress');
    }
    const deadline = clock() + Math.min(60_000, publicationTimeoutMs);
    while (['queued', 'running'].includes(result.status)) {
      if (clock() >= deadline) fail('installation_operation_in_progress');
      await delay(publicationPollMs);
      try {
        result = successful(await client.collections.runStatus(runId),
          ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
      } catch { fail('installation_operation_in_progress'); }
    }
    return result;
  }

  async function ensurePayPeriodBaseline(operationOptions) {
    const idempotencyKey = `${operationOptions.idempotencyKey}:periods`;
    let result = successful(await client.collections.startRun(
      PAYCOM_PERIODS_PLAN, {}, { idempotencyKey },
    ), ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
    const runId = result.data?.id;
    if (typeof runId !== 'string') fail('first_publication_failed');
    const deadline = clock() + Math.min(MAX_PAY_PERIOD_PREPARATION_MS, publicationTimeoutMs);
    for (;;) {
      await operationOptions.heartbeat();
      if (result.status === 'succeeded') return runId;
      if (['failed', 'cancelled'].includes(result.status)) fail('first_publication_failed');
      if (clock() >= deadline) {
        await cancelRunAndDrain(runId);
        fail('first_publication_failed');
      }
      await delay(publicationPollMs);
      result = successful(await client.collections.runStatus(runId),
        ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
    }
  }

  async function publishFirst(request, operationOptions) {
    if (!same(request, managedPaycomFirstPublicationRequest())) fail('runtime_boundary_violation');
    exact(operationOptions, ['idempotencyKey', 'heartbeat']);
    if (typeof operationOptions.idempotencyKey !== 'string'
        || !/^activation:[a-z][a-z0-9_-]{2,95}$/.test(operationOptions.idempotencyKey)
        || typeof operationOptions.heartbeat !== 'function') {
      fail('runtime_boundary_violation');
    }
    const preparationRunId = await ensurePayPeriodBaseline(operationOptions);
    let result = successful(await client.collections.enqueue(request, { idempotencyKey: operationOptions.idempotencyKey }),
      ['queued', 'running', 'succeeded', 'failed', 'cancelled'], 'first_publication_failed');
    const batchId = result.data?.id;
    if (typeof batchId !== 'string') fail('first_publication_failed');
    const deadline = clock() + publicationTimeoutMs;
    for (;;) {
      await operationOptions.heartbeat();
      result = await batch(batchId);
      if (['succeeded', 'failed', 'cancelled'].includes(result.status)) {
        return Object.freeze({ ...publicationFromBatch(result), preparationRunId });
      }
      if (clock() >= deadline) {
        await cancelAndDrain(batchId);
        fail('first_publication_failed');
      }
      await delay(publicationPollMs);
    }
  }

  async function verifyPublication(batchId, preparationRunId) {
    if (typeof preparationRunId !== 'string') fail('first_publication_failed');
    const batchResult = await batch(batchId);
    const terminal = publicationFromBatch(batchResult);
    if (terminal.status !== 'succeeded' || terminal.succeededRuns !== terminal.runCount
        || terminal.failedRuns !== 0 || terminal.cancelledRuns !== 0) fail('first_publication_failed');
    const manager = successful(await client.collections.health(), ['ready'], 'first_publication_failed');
    if (manager.data?.manager?.running !== true || manager.data?.databaseIntegrity !== 'ok'
        || manager.data?.counts?.queued !== 0
        || manager.data?.counts?.running !== 0
        || manager.data?.syncAlerts?.critical !== 0) fail('first_publication_failed');
    const sync = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found'], 'first_publication_failed');
    if (sync.data?.desiredState !== 'stopped' || sync.data?.activity !== 'idle'
        || sync.data?.activeRun !== null || sync.data?.queuedRunCount !== 0) {
      fail('first_publication_failed');
    }
    const health = successful(await client.paycom.health(), ['ready'], 'first_publication_failed');
    const data = health.data;
    if (data?.ready !== true || data.publicationStatus !== 'ready'
        || data.payPeriods?.projectionValid !== true
        || ![data.payPeriods, data.roster, data.timecards, data.resourceLinks]
          .every(value => value?.verified === true)) fail('first_publication_failed');
    const target = data.roster.target;
    if (typeof target !== 'string' || data.timecards.target !== target || data.resourceLinks.target !== target) {
      fail('first_publication_failed');
    }
    if (batchResult.data.runPage.items[0].targetKey !== target) fail('first_publication_failed');
    const evidence = await evidenceVerifier.verify({
      batchId,
      preparationRunId,
      definitionDigest: expectedDefinition().digest,
    });
    exact(evidence, [
      'definitionDigest', 'requestDigest', 'previewDigest', 'batchId', 'preparationRunId', 'target', 'runs',
      'publications', 'capturedAt',
    ], 'first_publication_failed');
    if (evidence.batchId !== batchId || evidence.preparationRunId !== preparationRunId
        || evidence.target !== target) fail('first_publication_failed');
    return Object.freeze({ ...evidence });
  }

  async function inspectSchedule() {
    const sync = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found'], 'runtime_health_failed');
    if (!['running', 'stopped'].includes(sync.data?.desiredState)) fail('runtime_health_failed');
    return Object.freeze({ syncWasRunning: sync.data.desiredState === 'running' });
  }

  async function quiesceSchedule(syncWasRunning) {
    if (typeof syncWasRunning !== 'boolean') fail('runtime_boundary_violation');
    const before = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found'], 'runtime_health_failed');
    if (before.data?.desiredState === 'running') {
      const stopped = successful(await client.sync.stop(PAYCOM_SYNC_ID, { drain: true }), ['stopped'], 'runtime_health_failed');
      if (stopped.data?.desiredState !== 'stopped' || stopped.data?.activity !== 'idle'
          || stopped.data?.activeRun !== null || stopped.data?.queuedRunCount !== 0) fail('runtime_health_failed');
    } else if (before.data?.desiredState !== 'stopped') fail('runtime_health_failed');
    const manager = successful(await client.collections.health(), ['ready'], 'runtime_health_failed');
    if (manager.data?.counts?.queued !== 0 || manager.data?.counts?.running !== 0) fail('runtime_health_failed');
    return Object.freeze({ syncWasRunning });
  }

  async function restoreSchedule(syncWasRunning) {
    if (typeof syncWasRunning !== 'boolean') fail('runtime_boundary_violation');
    const before = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found'], 'runtime_health_failed');
    if (syncWasRunning && before.data?.desiredState === 'stopped') {
      const started = successful(await client.sync.start(PAYCOM_SYNC_ID), ['started'], 'runtime_health_failed');
      if (started.data?.sync?.desiredState !== 'running') fail('runtime_health_failed');
    } else if (!syncWasRunning && before.data?.desiredState === 'running') {
      const stopped = successful(await client.sync.stop(PAYCOM_SYNC_ID, { drain: true }), ['stopped'], 'runtime_health_failed');
      if (stopped.data?.desiredState !== 'stopped' || stopped.data?.activity !== 'idle'
          || stopped.data?.activeRun !== null || stopped.data?.queuedRunCount !== 0) fail('runtime_health_failed');
    } else if (before.data?.desiredState !== (syncWasRunning ? 'running' : 'stopped')) {
      fail('runtime_health_failed');
    }
    return Object.freeze({ syncWasRunning });
  }

  return Object.freeze({
    verifyInfrastructure,
    configure,
    startWorkforceSync,
    testProvider,
    publishFirst,
    verifyPublication,
    inspectSchedule,
    quiesceSchedule,
    restoreSchedule,
  });
}

module.exports = { DEFAULT_PUBLICATION_TIMEOUT_MS, DEFAULT_PUBLICATION_POLL_MS, MAX_PAY_PERIOD_PREPARATION_MS, PAYCOM_PERIODS_PLAN, EXPECTED_FIRST_PUBLICATION_PLANS, createManagedPaycomActivationRuntime };
