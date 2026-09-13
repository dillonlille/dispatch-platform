'use strict';

const { PAYCOM_SYNC_ID } = require('../../../shared/paycom-activation');

function fail(code = 'runtime_health_failed') {
  throw Object.assign(new Error(code), { code });
}

function successful(value, statuses, code = 'runtime_health_failed') {
  if (!value?.ok || !statuses.includes(value.status)) fail(code);
  return value;
}

function createOciRuntimeLifecyclePort(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['client', 'clock'].includes(key))
      || !options.client?.sync || typeof options.client.sync.status !== 'function'
      || typeof options.client.sync.stop !== 'function' || typeof options.client.sync.start !== 'function'
      || !options.client?.collections || typeof options.client.collections.health !== 'function'
      || !options.client?.workforce || typeof options.client.workforce.day !== 'function'
      || !options.client?.system || typeof options.client.system.status !== 'function'
      || typeof options.client.health !== 'function') fail('runtime_boundary_violation');
  const client = options.client;
  const clock = options.clock || Date.now;
  if (typeof clock !== 'function') fail('runtime_boundary_violation');

  async function inspectSchedule() {
    const result = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found']);
    if (!['running', 'stopped'].includes(result.data?.desiredState)) fail();
    return Object.freeze({ syncWasRunning: result.data.desiredState === 'running' });
  }

  async function quiesceSchedule(syncWasRunning) {
    if (typeof syncWasRunning !== 'boolean') fail('runtime_boundary_violation');
    const before = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found']);
    if (before.data?.desiredState === 'running') {
      const stopped = successful(await client.sync.stop(PAYCOM_SYNC_ID, { drain: true, waitMs: 120_000 }), ['stopped']);
      if (stopped.data?.desiredState !== 'stopped' || stopped.data?.activity !== 'idle'
          || stopped.data?.activeRun !== null || stopped.data?.queuedRunCount !== 0) fail();
    } else if (before.data?.desiredState !== 'stopped') fail();
    const manager = successful(await client.collections.health(), ['ready']);
    if (manager.data?.counts?.queued !== 0 || manager.data?.counts?.running !== 0) fail();
    return Object.freeze({ syncWasRunning });
  }

  async function restoreSchedule(syncWasRunning) {
    if (typeof syncWasRunning !== 'boolean') fail('runtime_boundary_violation');
    const before = successful(await client.sync.status(PAYCOM_SYNC_ID), ['found']);
    if (syncWasRunning && before.data?.desiredState === 'stopped') {
      const started = successful(await client.sync.start(PAYCOM_SYNC_ID), ['started']);
      if (started.data?.sync?.desiredState !== 'running') fail();
    } else if (!syncWasRunning && before.data?.desiredState === 'running') {
      const stopped = successful(await client.sync.stop(PAYCOM_SYNC_ID, { drain: true, waitMs: 120_000 }), ['stopped']);
      if (stopped.data?.desiredState !== 'stopped' || stopped.data?.activity !== 'idle'
          || stopped.data?.activeRun !== null || stopped.data?.queuedRunCount !== 0) fail();
    } else if (before.data?.desiredState !== (syncWasRunning ? 'running' : 'stopped')) fail();
    return Object.freeze({ syncWasRunning });
  }

  async function verifyInfrastructure() {
    successful(await client.health(), ['ready']);
    successful(await client.system.status(), ['ready', 'degraded']);
    return Object.freeze({ status: 'verified' });
  }

  async function verifyPublication(priorEvidence, currentTarget = priorEvidence?.target) {
    if (!priorEvidence || typeof priorEvidence !== 'object' || typeof priorEvidence.target !== 'string') {
      fail('first_publication_failed');
    }
    await verifyInfrastructure();
    successful(await client.workforce.day({ date: currentTarget, limit: 1, offset: 0 }), ['found']);
    return Object.freeze({
      definitionDigest: priorEvidence.definitionDigest,
      requestDigest: priorEvidence.requestDigest,
      previewDigest: priorEvidence.previewDigest,
      batchId: priorEvidence.batchId,
      preparationRunId: priorEvidence.preparationRunId,
      target: priorEvidence.target,
      runs: priorEvidence.runs,
      publications: priorEvidence.publications,
      capturedAt: new Date(clock()).toISOString(),
    });
  }

  return Object.freeze({
    inspectSchedule, quiesceSchedule, restoreSchedule, verifyInfrastructure, verifyPublication,
  });
}

module.exports = { createOciRuntimeLifecyclePort };
