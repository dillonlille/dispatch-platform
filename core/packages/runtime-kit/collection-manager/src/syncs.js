'use strict';

const crypto = require('node:crypto');
const {
  ValidationError, plainObject, exactKeys, identifier, boundedJson, validateSchema, validateAgainstSchema,
} = require('dispatch-runtime-kit/collection-manager/src/validation');

const DESIRED_STATES = Object.freeze(['running', 'stopped']);
const OVERLAP_POLICIES = Object.freeze(['coalesce']);
const BLOCKED_PROBE_SECONDS = 60 * 60;

function validateSyncDefinition(value) {
  exactKeys(value, [
    'id', 'plan', 'intervalSeconds', 'jitterSeconds', 'overlap',
    'settingsSchema', 'settings', 'desiredState', 'replaceSettingsOnApply',
  ], ['id', 'plan', 'intervalSeconds', 'settingsSchema', 'settings', 'desiredState']);
  identifier(value.id);
  identifier(value.plan);
  if (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 10 || value.intervalSeconds > 31_536_000) throw new ValidationError();
  const jitterSeconds = value.jitterSeconds === undefined ? 0 : value.jitterSeconds;
  if (!Number.isInteger(jitterSeconds) || jitterSeconds < 0 || jitterSeconds >= value.intervalSeconds) throw new ValidationError();
  const overlap = value.overlap === undefined ? 'coalesce' : value.overlap;
  if (!OVERLAP_POLICIES.includes(overlap)) throw new ValidationError('unsupported_overlap_policy');
  validateSchema(value.settingsSchema);
  validateAgainstSchema(value.settings, value.settingsSchema);
  if (!DESIRED_STATES.includes(value.desiredState)) throw new ValidationError('invalid_sync_state');
  if (value.replaceSettingsOnApply !== undefined && typeof value.replaceSettingsOnApply !== 'boolean') throw new ValidationError();
  boundedJson(value.settings, { maxBytes: 16_384 });
  return {
    id: value.id,
    plan: value.plan,
    intervalSeconds: value.intervalSeconds,
    jitterSeconds,
    overlap,
    settingsSchema: JSON.parse(JSON.stringify(value.settingsSchema)),
    settings: JSON.parse(JSON.stringify(value.settings)),
    desiredState: value.desiredState,
    replaceSettingsOnApply: value.replaceSettingsOnApply ?? false,
  };
}

function validateSyncPatch(value) {
  if (!plainObject(value)) throw new ValidationError();
  exactKeys(value, ['intervalSeconds', 'jitterSeconds', 'settings', 'replaceSettings'], []);
  if (Object.keys(value).length === 0) throw new ValidationError();
  if (value.intervalSeconds !== undefined
      && (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 10 || value.intervalSeconds > 31_536_000)) throw new ValidationError();
  if (value.jitterSeconds !== undefined && (!Number.isInteger(value.jitterSeconds) || value.jitterSeconds < 0)) throw new ValidationError();
  if (value.settings !== undefined && !plainObject(value.settings)) throw new ValidationError();
  if (value.replaceSettings !== undefined && typeof value.replaceSettings !== 'boolean') throw new ValidationError();
  if (value.replaceSettings === true && value.settings === undefined) throw new ValidationError();
  boundedJson(value, { maxBytes: 16_384 });
  return JSON.parse(JSON.stringify(value));
}

function deterministicJitter(syncId, generation, window, jitterSeconds, runtimeKey = process.env.DISPATCH_RUNTIME_KEY || '') {
  if (jitterSeconds === 0) return 0;
  const digest = crypto.createHash('sha256').update(`${runtimeKey}:${syncId}:${generation}:${window}`).digest();
  return digest.readUInt32BE(0) % (jitterSeconds + 1);
}

function nextDue(sync, timestamp) {
  const intervalSeconds = sync.blocked ? Math.max(sync.intervalSeconds, BLOCKED_PROBE_SECONDS) : sync.intervalSeconds;
  const base = timestamp + intervalSeconds * 1000;
  return base + deterministicJitter(sync.id, sync.generation, base, sync.jitterSeconds) * 1000;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class SyncService {
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  list(limit = 50, offset = 0) { return this.store.syncs(limit, offset); }
  status(id) { return this.store.sync(id); }
  history(id, limit = 50, offset = 0) { return this.store.syncHistory(id, limit, offset); }

  start(id, { runNow = true, timestamp = this.clock() } = {}) {
    const current = this.store.sync(id, timestamp);
    if (current.desiredState === 'running') return { sync: current, run: null };
    const sync = this.store.setSyncDesiredState(id, 'running', timestamp, { incrementGeneration: true });
    let run = null;
    if (runNow) run = this.store.enqueueSync(id, { trigger: 'sync_start', timestamp, windowKey: `start:${sync.generation}` });
    this.store.setSyncNextDue(id, nextDue(this.store.sync(id), timestamp), timestamp);
    return { sync: this.store.sync(id), run };
  }

  async stop(id, { drain = false, waitMs = 30_000, timestamp = this.clock() } = {}) {
    if (typeof drain !== 'boolean' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new ValidationError();
    this.store.setSyncDesiredState(id, 'stopped', timestamp);
    this.store.stopSyncRuns(id, { cancelActive: !drain });
    const deadline = Date.now() + waitMs;
    let current = this.store.sync(id);
    while (current.activeRun && Date.now() < deadline) {
      await delay(25);
      current = this.store.sync(id);
    }
    if (current.activeRun) throw Object.assign(new Error('sync_stop_timeout'), { code: 'sync_stop_timeout' });
    return current;
  }

  async restart(id, options = {}) {
    const { drain = false, waitMs = 30_000, timestamp = this.clock() } = options;
    await this.stop(id, { drain, waitMs, timestamp });
    return this.start(id, { runNow: true, timestamp: Math.max(timestamp, this.clock()) });
  }

  runNow(id, { timestamp = this.clock(), idempotencyKey = null } = {}) {
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(idempotencyKey))) throw new ValidationError();
    const sync = this.store.sync(id);
    // Pausing automatic scheduling does not disable an explicit manual request.
    const run = this.store.enqueueSync(id, {
      trigger: 'sync_manual', timestamp,
      windowKey: `manual:${idempotencyKey || crypto.randomUUID()}`,
    });
    return { sync: this.store.sync(id), run };
  }

  async edit(id, patch, { expectedRevision = null, applyNow = false, waitMs = 30_000, timestamp = this.clock() } = {}) {
    validateSyncPatch(patch);
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new ValidationError();
    if (typeof applyNow !== 'boolean') throw new ValidationError();
    let edited = this.store.editSync(id, patch, { expectedRevision, timestamp });
    if (edited.desiredState === 'running') {
      edited = this.store.setSyncNextDue(id, nextDue(edited, timestamp), timestamp);
    }
    if (!applyNow || edited.desiredState !== 'running') return { sync: edited, run: null };
    return this.restart(id, { waitMs, timestamp });
  }

  schedule(timestamp = this.clock()) {
    const queued = [];
    for (const sync of this.store.dueSyncs(timestamp)) {
      const due = sync.nextDueAt;
      const run = this.store.enqueueSync(sync.id, {
        trigger: 'sync_schedule', timestamp, windowKey: String(due),
      });
      this.store.setSyncNextDue(sync.id, nextDue(this.store.sync(sync.id), timestamp), timestamp);
      if (run) queued.push(run);
    }
    return queued;
  }
}

module.exports = {
  DESIRED_STATES, OVERLAP_POLICIES, BLOCKED_PROBE_SECONDS, validateSyncDefinition, validateSyncPatch,
  deterministicJitter, nextDue, SyncService,
};
