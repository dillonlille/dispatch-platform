'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  METHOD_RE, VERSION_RE, ValidationError, plainObject, exactKeys, identifier,
  boundedJson, validateSchema, validateAgainstSchema, validateSchedule, validateSpec,
} = require('dispatch-runtime-kit/collection-manager/src/validation');
const { validateCollectionCapabilities, validateCollectionRequest, validateCollectionSchedule } = require('dispatch-runtime-kit/collection-manager/src/targeting');
const { validateSyncDefinition, validateSyncPatch } = require('dispatch-runtime-kit/collection-manager/src/syncs');

const { StoreError } = require('dispatch-runtime-kit/collection-manager/src/store-error');
const { SCHEMA_VERSION, initializeCollectionSchema } = require('dispatch-runtime-kit/collection-manager/src/schema');
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const AUTH_BLOCK_PROBE_MS = 60 * 60 * 1000;
const NO_CHANGE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_COMPACTION_DELETE = 100;
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const ATTEMPT_STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const ALERT_SEVERITIES = new Set(['warning', 'error', 'critical']);
const INTEGRITY_ERRORS = new Set([
  'integrity_failed', 'publication_verification_failed', 'business_delta_invalid',
  'membership_mismatch', 'database_integrity_failed', 'workforce_inconsistent',
]);
const AUTH_ERRORS = new Set([
  'profile_locked', 'manual_verification_required', 'account_locked', 'captcha_required',
  'mfa_required', 'security_challenge', 'invalid_credentials',
]);

function mode(info) { return info.mode & 0o777; }

function ensurePrivateDirectory(directory) {
  directory = path.resolve(directory);
  const parent = path.dirname(directory);
  let parentInfo;
  try { parentInfo = fs.lstatSync(parent); } catch { throw new StoreError('unsafe_storage'); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.geteuid()
      || (mode(parentInfo) & 0o022) !== 0 || fs.realpathSync(parent) !== parent) throw new StoreError('unsafe_storage');
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || mode(info) !== 0o700
      || fs.realpathSync(directory) !== directory) throw new StoreError('unsafe_storage');
}

function safeRegularFile(file, expectedMode = 0o600) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || mode(info) !== expectedMode || fs.realpathSync(file) !== path.resolve(file)) throw new StoreError('unsafe_storage');
  return info;
}

function safeExecutable(command) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || command.length > 4096 || path.resolve(command) !== command) throw new ValidationError();
  let parent = path.dirname(command);
  while (true) {
    let parentInfo;
    try { parentInfo = fs.lstatSync(parent); } catch { throw new ValidationError('collector_unavailable'); }
    const parentMode = parentInfo.mode & 0o7777;
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || ![0, process.geteuid()].includes(parentInfo.uid)
        || ((parentMode & 0o022) !== 0 && (parentMode & 0o1000) === 0)) {
      throw new ValidationError('unsafe_collector');
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  let info;
  try { info = fs.lstatSync(command); } catch { throw new ValidationError('collector_unavailable'); }
  const sharedRuntimeExecutable = process.env.DISPATCH_RUNTIME_BACKEND === 'native_service_v1'
    && command.startsWith('/opt/dispatch/') && info.uid === 0 && (mode(info) & 0o222) === 0;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() && !sharedRuntimeExecutable || info.nlink !== 1
      || (mode(info) & 0o022) !== 0 || (mode(info) & 0o100) === 0 || fs.realpathSync(command) !== command) {
    throw new ValidationError('unsafe_collector');
  }
  return command;
}

function json(value) { return JSON.stringify(value); }
function parseJson(value) { return JSON.parse(value); }
function nowMs() { return Date.now(); }

function validateRunPolicy(value) {
  if (value === null) return null;
  exactKeys(value, ['maxAttempts', 'backoffSeconds', 'retryDeadline', 'retryErrors']);
  if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 512
      || !Array.isArray(value.backoffSeconds) || value.backoffSeconds.length < 1
      || value.backoffSeconds.length > 511
      || value.backoffSeconds.some(seconds => !Number.isInteger(seconds) || seconds < 1 || seconds > 604_800)
      || !Number.isInteger(value.retryDeadline) || value.retryDeadline < 0
      || !Array.isArray(value.retryErrors) || value.retryErrors.length < 1 || value.retryErrors.length > 32
      || new Set(value.retryErrors).size !== value.retryErrors.length
      || value.retryErrors.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code))) {
    throw new ValidationError();
  }
  boundedJson(value);
  return value;
}

function publicCollector(row) {
  return {
    id: row.id, version: row.version, description: row.description, command: row.command,
    sourceSchema: parseJson(row.source_schema_json),
    enabled: Boolean(row.enabled), updatedAt: row.updated_at,
  };
}

function publicSource(row) {
  return {
    id: row.id, collector: row.collector_id, authProfile: row.auth_profile,
    config: parseJson(row.config_json), collection: row.collection_json ? parseJson(row.collection_json) : null,
    enabled: Boolean(row.enabled), updatedAt: row.updated_at,
  };
}

function publicPlan(row) {
  return {
    id: row.id, source: row.source_id, method: row.method_id,
    schedule: parseJson(row.schedule_json), input: parseJson(row.input_json),
    dependsOn: parseJson(row.depends_on_json), enabled: Boolean(row.enabled),
    timeoutSeconds: row.timeout_seconds, maxAttempts: row.max_attempts,
    nextDueAt: row.next_due_at, updatedAt: row.updated_at,
  };
}

function publicCollectionSchedule(row) {
  return {
    id: row.id, request: parseJson(row.request_json), schedule: parseJson(row.schedule_json),
    enabled: Boolean(row.enabled), nextDueAt: row.next_due_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function attemptCategory(status, error) {
  if (status === 'succeeded') return 'success';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'interrupted' || error?.startsWith('manager_')) return 'manager';
  if (error && (AUTH_ERRORS.has(error) || /^(?:auth|profile|session|credential|account|mfa|captcha|security_|broker|acquisition)/.test(error))) return 'authentication';
  if (error && /^(?:browser|cdp|navigation|lease_)/.test(error)) return 'browser';
  if (error && (INTEGRITY_ERRORS.has(error) || /^(?:publication|membership|business_delta|stale_collection)/.test(error))) return 'integrity';
  if (error && /^(?:paycom|roster|timecard|resource_)/.test(error)) return 'provider';
  return 'collector';
}

function publicAttempt(row) {
  if (!ATTEMPT_STATUSES.has(row.status)) throw new StoreError('schema_invalid');
  return {
    attempt: row.attempt, status: row.status, category: attemptCategory(row.status, row.error_code),
    startedAt: row.started_at,
    finishedAt: row.finished_at, error: row.error_code, exitCode: row.exit_code,
  };
}

function businessContextFromReceipt(receiptJson) {
  if (!receiptJson) return null;
  let receipt;
  try { receipt = parseJson(receiptJson); } catch { return null; }
  const date = receipt?.data?.businessDate;
  const timezone = receipt?.data?.businessTimezone;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || typeof timezone !== 'string' || timezone.length < 1 || timezone.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { return null; }
  return { date, timezone };
}

function publicRun(row, { includeReceipt = true, attempts = null } = {}) {
  const result = {
    id: row.id, plan: row.plan_id, source: row.source_id, collector: row.collector_id,
    method: row.method_id, trigger: row.trigger, logicalKey: row.logical_key,
    status: row.status, attempt: row.attempt, maxAttempts: row.max_attempts,
    runAfter: row.run_after, startedAt: row.started_at, finishedAt: row.finished_at,
    error: row.error_code, blocked: row.blocked_reason,
    receipt: includeReceipt && row.receipt_json ? parseJson(row.receipt_json) : null,
    cancelRequested: Boolean(row.cancel_requested), collectorVersion: row.collector_version,
    retryDeadline: row.retry_deadline ?? null,
    retryErrors: row.retryable_errors_json ? parseJson(row.retryable_errors_json) : null,
  };
  if (attempts !== null) {
    result.attempts = attempts.map(publicAttempt);
    result.attemptHistoryComplete = result.attempt === 0
      ? result.attempts.length === 0
      : result.attempts.length === result.attempt
        && result.attempts.every((attempt, index) => attempt.attempt === index + 1);
  }
  return result;
}

function batchStatus(counts, runCount) {
  if (counts.running > 0) return 'running';
  if (counts.queued > 0 && counts.succeeded + counts.failed + counts.cancelled > 0) return 'running';
  if (counts.queued > 0) return 'queued';
  if (counts.failed > 0) return 'failed';
  if (counts.cancelled > 0) return 'cancelled';
  if (runCount > 0 && counts.succeeded === runCount) return 'succeeded';
  return 'queued';
}

class CollectionStore {
  constructor(paths, { readOnly = false, plugins = null } = {}) {
    this.paths = paths;
    this.readOnly = readOnly;
    this.db = null;
    const root = path.resolve(paths.databaseRoot);
    if (root !== paths.databaseRoot || path.resolve(paths.database) !== paths.database || path.dirname(paths.database) !== root) {
      throw new StoreError('unsafe_storage');
    }
    if (readOnly && !fs.existsSync(root)) throw new StoreError('collection_manager_not_initialized');
    ensurePrivateDirectory(root);
    const existing = fs.existsSync(paths.database);
    if (readOnly && !existing) throw new StoreError('collection_manager_not_initialized');
    if (existing) {
      const info = safeRegularFile(paths.database);
      if (info.size < 1 || info.size > MAX_DATABASE_BYTES) throw new StoreError('unsafe_storage');
    }
    try {
      this.db = new DatabaseSync(paths.database, { readOnly });
      if (!existing) fs.chmodSync(paths.database, 0o600);
      safeRegularFile(paths.database);
      require('./plugin-state').configurePluginState(this.db,plugins);
      initializeCollectionSchema(this.db, readOnly);
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.db = null;
      throw error;
    }
  }

  close() { if (this.db) this.db.close(); this.db = null; }

  transaction(callback) {
    const nested = this.db.isTransaction;
    const point = `dispatch_transaction_${this.transactionSequence = (this.transactionSequence || 0) + 1}`;
    this.db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec(nested ? `RELEASE ${point}` : 'COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK'); } catch {}
      throw error;
    }
  }

  // A deferred savepoint keeps multi-query views consistent without blocking the
  // manager's WAL writes, and also works inside an existing write transaction.
  readSnapshot(callback) {
    this.db.exec('SAVEPOINT collection_read');
    try {
      const result = callback();
      this.db.exec('RELEASE collection_read');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO collection_read; RELEASE collection_read');
      throw error;
    }
  }

  applySpec(spec, timestamp = nowMs()) {
    validateSpec(spec);
    const ids = (items, field = 'id') => {
      const values = items.map(item => item[field]);
      if (new Set(values).size !== values.length) throw new ValidationError();
    };
    ids(spec.collectors); ids(spec.sources); ids(spec.plans); ids(spec.syncs || []);
    return this.transaction(() => {
      for (const collector of spec.collectors) {
        exactKeys(collector, ['id', 'version', 'description', 'command', 'sourceSchema', 'methods']);
        identifier(collector.id); identifier(collector.version, VERSION_RE);
        if (typeof collector.description !== 'string' || collector.description.length < 1 || collector.description.length > 512 || !plainObject(collector.methods)) throw new ValidationError();
        safeExecutable(collector.command);
        validateSchema(collector.sourceSchema);

        const upsert = this.db.prepare(`
          INSERT INTO collectors(id,version,description,command,source_schema_json,collection_json,enabled,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET
          version=excluded.version,description=excluded.description,command=excluded.command,
          source_schema_json=excluded.source_schema_json,collection_json=excluded.collection_json,enabled=1,updated_at=excluded.updated_at
        `);
        upsert.run(collector.id, collector.version, collector.description, collector.command, json(collector.sourceSchema),
          null, timestamp, timestamp);
        if (Object.keys(collector.methods).length < 1 || Object.keys(collector.methods).length > 64) throw new ValidationError();
        for (const [methodId, method] of Object.entries(collector.methods)) {
          identifier(methodId, METHOD_RE);
          exactKeys(method, ['description', 'inputSchema', 'timeoutSeconds', 'maxAttempts', 'backoffSeconds', 'concurrencyKeys']);
          if (typeof method.description !== 'string' || method.description.length < 1 || method.description.length > 512) throw new ValidationError();
          validateSchema(method.inputSchema);
          if (!Number.isInteger(method.timeoutSeconds) || method.timeoutSeconds < 1 || method.timeoutSeconds > 86_400) throw new ValidationError();
          if (!Number.isInteger(method.maxAttempts) || method.maxAttempts < 1 || method.maxAttempts > 10) throw new ValidationError();
          if (!Array.isArray(method.backoffSeconds) || method.backoffSeconds.length > 10
              || method.backoffSeconds.some(value => !Number.isInteger(value) || value < 0 || value > 86_400)) throw new ValidationError();
          if (!Array.isArray(method.concurrencyKeys) || method.concurrencyKeys.length > 16
              || method.concurrencyKeys.some(value => typeof value !== 'string' || value.length < 1 || value.length > 128
                || !/^[A-Za-z0-9_.:{}-]+$/.test(value))) throw new ValidationError();
          this.db.prepare(`
            INSERT INTO methods(collector_id,id,description,input_schema_json,timeout_seconds,max_attempts,backoff_json,concurrency_keys_json)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(collector_id,id) DO UPDATE SET
            description=excluded.description,input_schema_json=excluded.input_schema_json,
            timeout_seconds=excluded.timeout_seconds,max_attempts=excluded.max_attempts,
            backoff_json=excluded.backoff_json,concurrency_keys_json=excluded.concurrency_keys_json
          `).run(collector.id, methodId, method.description, json(method.inputSchema), method.timeoutSeconds,
            method.maxAttempts, json(method.backoffSeconds), json(method.concurrencyKeys));
        }
      }

      for (const source of spec.sources) {
        exactKeys(source, ['id', 'collector', 'authProfile', 'config', 'collection', 'enabled'],
          ['id', 'collector', 'authProfile', 'config', 'enabled']);
        identifier(source.id); identifier(source.collector);
        if (source.authProfile !== null) identifier(source.authProfile);
        if (typeof source.enabled !== 'boolean') throw new ValidationError();
        const collector = this.db.prepare('SELECT source_schema_json FROM collectors WHERE id=? AND enabled=1').get(source.collector);
        if (!collector) throw new ValidationError('collector_not_found');
        validateAgainstSchema(source.config, parseJson(collector.source_schema_json));
        if (source.collection !== undefined) validateCollectionCapabilities(source.collection);
        this.db.prepare(`
          INSERT INTO sources(id,collector_id,auth_profile,config_json,collection_json,enabled,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET collector_id=excluded.collector_id,
          auth_profile=excluded.auth_profile,config_json=excluded.config_json,collection_json=excluded.collection_json,
          enabled=excluded.enabled,updated_at=excluded.updated_at
        `).run(source.id, source.collector, source.authProfile, json(source.config),
          source.collection === undefined ? null : json(source.collection), Number(source.enabled), timestamp, timestamp);
      }

      for (const plan of spec.plans) {
        exactKeys(plan, ['id', 'source', 'method', 'schedule', 'input', 'dependsOn', 'enabled', 'timeoutSeconds', 'maxAttempts'],
          ['id', 'source', 'method', 'schedule', 'input', 'dependsOn', 'enabled']);
        identifier(plan.id); identifier(plan.source); identifier(plan.method, METHOD_RE);
        validateSchedule(plan.schedule);
        if (!Array.isArray(plan.dependsOn) || plan.dependsOn.length > 32 || typeof plan.enabled !== 'boolean') throw new ValidationError();
        const source = this.db.prepare('SELECT collector_id FROM sources WHERE id=?').get(plan.source);
        if (!source) throw new ValidationError('source_not_found');
        const method = this.db.prepare('SELECT * FROM methods WHERE collector_id=? AND id=?').get(source.collector_id, plan.method);
        if (!method) throw new ValidationError('method_not_found');
        validateAgainstSchema(plan.input, parseJson(method.input_schema_json));
        for (const dependency of plan.dependsOn) {
          exactKeys(dependency, ['plan', 'maxAgeSeconds']);
          identifier(dependency.plan);
          if (dependency.plan === plan.id || !Number.isInteger(dependency.maxAgeSeconds) || dependency.maxAgeSeconds < 1 || dependency.maxAgeSeconds > 31_536_000) throw new ValidationError();
        }
        const timeout = plan.timeoutSeconds === undefined ? method.timeout_seconds : plan.timeoutSeconds;
        const attempts = plan.maxAttempts === undefined ? method.max_attempts : plan.maxAttempts;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400 || !Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new ValidationError();
        const existing = this.db.prepare('SELECT schedule_json,next_due_at FROM plans WHERE id=?').get(plan.id);
        let nextDue = existing?.next_due_at ?? null;
        if (!existing || existing.schedule_json !== json(plan.schedule)) {
          nextDue = plan.schedule.type === 'interval' ? timestamp + plan.schedule.seconds * 1000 : null;
        }
        this.db.prepare(`
          INSERT INTO plans(id,source_id,method_id,schedule_json,input_json,depends_on_json,enabled,timeout_seconds,max_attempts,next_due_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          source_id=excluded.source_id,method_id=excluded.method_id,schedule_json=excluded.schedule_json,
          input_json=excluded.input_json,depends_on_json=excluded.depends_on_json,enabled=excluded.enabled,
          timeout_seconds=excluded.timeout_seconds,max_attempts=excluded.max_attempts,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at
        `).run(plan.id, plan.source, plan.method, json(plan.schedule), json(plan.input), json(plan.dependsOn),
          Number(plan.enabled), timeout, attempts, nextDue, timestamp, timestamp);
      }

      for (const plan of spec.plans) {
        for (const dependency of plan.dependsOn) {
          if (!this.db.prepare('SELECT 1 present FROM plans WHERE id=?').get(dependency.plan)) throw new ValidationError('dependency_not_found');
        }
      }
      const dependencyGraph = new Map(this.db.prepare('SELECT id,depends_on_json FROM plans').all()
        .map(row => [row.id, parseJson(row.depends_on_json).map(item => item.plan)]));
      const visiting = new Set();
      const visited = new Set();
      const visit = id => {
        if (visiting.has(id)) throw new ValidationError('dependency_cycle');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of dependencyGraph.get(id) || []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const id of dependencyGraph.keys()) visit(id);
      for (const source of spec.sources.filter(item => item.collection !== undefined)) {
        if (typeof source.config.timezone !== 'string') throw new ValidationError('invalid_timezone');
        try { new Intl.DateTimeFormat('en-CA', { timeZone: source.config.timezone }).format(new Date(0)); }
        catch { throw new ValidationError('invalid_timezone'); }
        const resolver = this.db.prepare('SELECT 1 present FROM methods WHERE collector_id=? AND id=?').get(source.collector, source.collection.resolverMethod);
        if (!resolver) throw new ValidationError('method_not_found');
        for (const scope of Object.values(source.collection.scopes)) {
          for (const task of [...scope.tasks, ...(scope.auditTasks || [])]) {
            const plan = this.db.prepare('SELECT source_id FROM plans WHERE id=?').get(task.plan);
            if (!plan) throw new ValidationError('plan_not_found');
            if (plan.source_id !== source.id) throw new ValidationError('source_not_found');
          }
        }
      }
      for (const raw of spec.syncs || []) {
        const definition = validateSyncDefinition(raw);
        const plan = this.loadPlan(definition.plan);
        if (parseJson(plan.schedule_json).type !== 'manual') throw new ValidationError('sync_plan_must_be_manual');
        const merged = { ...parseJson(plan.input_json), ...definition.settings };
        validateAgainstSchema(merged, parseJson(plan.input_schema_json));
        const existing = this.db.prepare('SELECT * FROM sync_definitions WHERE id=?').get(definition.id);
        if (existing) {
          if (definition.replaceSettingsOnApply) {
            if (existing.desired_state !== 'stopped') throw new ValidationError('sync_migration_requires_stopped');
            const revision = existing.revision + 1;
            this.db.prepare(`UPDATE sync_definitions SET plan_id=?,settings_schema_json=?,settings_json=?,revision=?,updated_at=? WHERE id=?`)
              .run(definition.plan, json(definition.settingsSchema), json(definition.settings), revision, timestamp, definition.id);
            this.db.prepare(`INSERT INTO sync_revisions(sync_id,revision,interval_seconds,jitter_seconds,settings_json,created_at)
              VALUES(?,?,?,?,?,?)`).run(definition.id, revision, existing.interval_seconds,
              existing.jitter_seconds, json(definition.settings), timestamp);
          } else {
            const existingSettings = parseJson(existing.settings_json);
            try {
              validateAgainstSchema(existingSettings, definition.settingsSchema);
              validateAgainstSchema({ ...parseJson(plan.input_json), ...existingSettings }, parseJson(plan.input_schema_json));
            } catch { throw new ValidationError('sync_config_incompatible'); }
            this.db.prepare(`UPDATE sync_definitions SET plan_id=?,settings_schema_json=?,updated_at=? WHERE id=?`)
              .run(definition.plan, json(definition.settingsSchema), timestamp, definition.id);
          }
        } else {
          const nextDue = definition.desiredState === 'running' ? timestamp + definition.intervalSeconds * 1000 : null;
          this.db.prepare(`INSERT INTO sync_definitions(
            id,plan_id,desired_state,interval_seconds,jitter_seconds,overlap_policy,
            settings_schema_json,settings_json,revision,generation,next_due_at,
            created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,0,?,?,?)`).run(
            definition.id, definition.plan, definition.desiredState, definition.intervalSeconds,
            definition.jitterSeconds, definition.overlap, json(definition.settingsSchema),
            json(definition.settings), nextDue, timestamp, timestamp,
          );
          this.db.prepare(`INSERT INTO sync_revisions(sync_id,revision,interval_seconds,jitter_seconds,settings_json,created_at)
            VALUES(?,1,?,?,?,?)`).run(definition.id, definition.intervalSeconds,
            definition.jitterSeconds, json(definition.settings), timestamp);
        }
      }
      return { collectors: spec.collectors.length, sources: spec.sources.length, plans: spec.plans.length, syncs: (spec.syncs || []).length };
    });
  }

  collectors() { return this.db.prepare('SELECT * FROM collectors ORDER BY id').all().map(publicCollector); }
  collector(id) {
    identifier(id);
    const row = this.db.prepare('SELECT * FROM collectors WHERE id=?').get(id);
    if (!row) throw new StoreError('collector_not_found');
    return publicCollector(row);
  }
  sources() { return this.db.prepare('SELECT * FROM sources ORDER BY id').all().map(publicSource); }
  source(id) {
    identifier(id);
    const row = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    if (!row) throw new StoreError('source_not_found');
    return publicSource(row);
  }
  sourceRuntime(id, { allowDisabled = false } = {}) {
    identifier(id);
    const row = this.db.prepare(`SELECT s.*,c.version collector_version,c.command,c.enabled collector_enabled
      FROM sources s JOIN collectors c ON c.id=s.collector_id WHERE s.id=?`).get(id);
    if (!row) throw new StoreError('source_not_found');
    if (!allowDisabled && (!row.enabled || !row.collector_enabled || !require('dispatch-runtime-kit/collection-manager/src/plugin-state').collectorEnabled(this.db, row.collector_id))) throw new StoreError('plan_disabled');
    if (!row.collection_json) throw new StoreError('collection_capabilities_not_found');
    return {
      id: row.id, collector: row.collector_id, authProfile: row.auth_profile,
      config: parseJson(row.config_json), collection: parseJson(row.collection_json),
      collectorVersion: row.collector_version, command: row.command,
    };
  }
  plans() { return this.db.prepare('SELECT * FROM plans ORDER BY id').all().map(publicPlan); }
  plan(id) {
    identifier(id);
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(id);
    if (!row) throw new StoreError('plan_not_found');
    return publicPlan(row);
  }

  methods(collectorId = null) {
    if (collectorId) this.collector(collectorId);
    const rows = collectorId
      ? this.db.prepare('SELECT * FROM methods WHERE collector_id=? ORDER BY id').all(collectorId)
      : this.db.prepare('SELECT * FROM methods ORDER BY collector_id,id').all();
    return rows.map(row => ({ collector: row.collector_id, id: row.id, description: row.description,
      inputSchema: parseJson(row.input_schema_json), timeoutSeconds: row.timeout_seconds,
      maxAttempts: row.max_attempts, backoffSeconds: parseJson(row.backoff_json),
      concurrencyKeys: parseJson(row.concurrency_keys_json) }));
  }

  runAttempts(id) {
    identifier(id);
    return this.db.prepare(`SELECT attempt,status,started_at,finished_at,exit_code,error_code
      FROM run_attempts WHERE run_id=? ORDER BY attempt`).all(id);
  }

  _syncAlerts(row, linked, timestamp) {
    const alerts = [];
    const push = (code, severity, count, sinceAt, error = null) => {
      if (!ALERT_SEVERITIES.has(severity) || !Number.isInteger(count) || count < 1) throw new StoreError('schema_invalid');
      alerts.push({ code, severity, count, sinceAt, error });
    };
    const failureStreak = this.db.prepare(`WITH terminal AS (
        SELECT r.status,r.finished_at,r.id FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
        WHERE sr.sync_id=? AND r.status IN ('succeeded','failed','cancelled')
      ), boundary AS (
        SELECT finished_at,id FROM terminal WHERE status IN ('succeeded','cancelled')
        ORDER BY finished_at DESC,id DESC LIMIT 1
      )
      SELECT COUNT(*) count,MIN(finished_at) since_at FROM terminal
      WHERE status='failed' AND (
        NOT EXISTS (SELECT 1 FROM boundary)
        OR finished_at>(SELECT finished_at FROM boundary)
        OR (finished_at=(SELECT finished_at FROM boundary) AND id>(SELECT id FROM boundary))
      )`).get(row.id);
    if (failureStreak.count >= 2) {
      const latestFailure = this.db.prepare(`SELECT r.error_code FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
        WHERE sr.sync_id=? AND r.status='failed' ORDER BY r.finished_at DESC,r.id DESC LIMIT 1`).get(row.id);
      push('consecutive_failures', 'error', failureStreak.count,
        failureStreak.since_at, latestFailure?.error_code || 'collector_failed');
    }
    if (row.desired_state === 'running') {
      const reference = row.last_succeeded_at ?? row.created_at;
      const elapsed = Math.max(0, timestamp - reference);
      const threshold = row.interval_seconds * 2 * 1000;
      if (elapsed > threshold) {
        push(row.last_succeeded_at === null ? 'no_success' : 'stale_success', 'error',
          Math.max(2, Math.floor(elapsed / (row.interval_seconds * 1000))), reference, row.last_error_code);
      }
    }
    if (row.last_error_code && INTEGRITY_ERRORS.has(row.last_error_code)) {
      push('integrity_failure', 'critical', 1, row.updated_at, row.last_error_code);
    }
    if (row.last_error_code && AUTH_ERRORS.has(row.last_error_code)) {
      push('authentication_blocked', 'critical', 1, row.updated_at, row.last_error_code);
    }
    if (linked?.status === 'running' && linked.blocked_reason !== 'waiting_for_capacity' && !linked.cancel_requested && linked.started_at !== null
        && timestamp > linked.started_at + linked.timeout_seconds * 1000 + 30_000) {
      push('run_overdue', 'critical', 1, linked.started_at, null);
    }
    return alerts;
  }

  _syncRow(id) {
    identifier(id);
    const row = this.db.prepare(`SELECT d.*,p.source_id,p.method_id,s.collector_id
      FROM sync_definitions d JOIN plans p ON p.id=d.plan_id
      JOIN sources s ON s.id=p.source_id WHERE d.id=?`).get(id);
    if (!row) throw new StoreError('sync_not_found');
    return row;
  }

  _publicSync(row, timestamp = nowMs()) {
    const linked = this.db.prepare(`SELECT r.* FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
      WHERE sr.sync_id=? AND r.status IN ('queued','running')
      ORDER BY CASE r.status WHEN 'running' THEN 0 ELSE 1 END,r.created_at LIMIT 1`).get(row.id);
    const queuedRunCount = this.db.prepare(`SELECT COUNT(*) count FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
      WHERE sr.sync_id=? AND r.status='queued'`).get(row.id).count;
    let activity = row.desired_state === 'running' && row.blocked_reason ? 'blocked' : 'idle';
    if (linked?.status === 'running') activity = linked.cancel_requested
      || row.desired_state === 'stopped' && linked.trigger !== 'sync_manual' ? 'stopping' : 'syncing';
    if (activity === 'syncing' && linked.blocked_reason === 'waiting_for_capacity') activity = 'waiting_for_capacity';
    else if (linked?.status === 'queued') activity = linked.run_after > timestamp ? 'backing_off' : 'queued';
    const latestSuccessful = this.db.prepare(`SELECT r.receipt_json FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
      WHERE sr.sync_id=? AND r.status='succeeded' ORDER BY r.finished_at DESC,r.id DESC LIMIT 1`).get(row.id);
    const businessContext = businessContextFromReceipt(latestSuccessful?.receipt_json || null);
    const alerts = this._syncAlerts(row, linked, timestamp);
    return {
      id: row.id, plan: row.plan_id, source: row.source_id, collector: row.collector_id, method: row.method_id,
      desiredState: row.desired_state, activity,
      intervalSeconds: row.interval_seconds, jitterSeconds: row.jitter_seconds, overlap: row.overlap_policy,
      settingsSchema: parseJson(row.settings_schema_json), settings: parseJson(row.settings_json),
      revision: row.revision, generation: row.generation, nextDueAt: row.next_due_at,
      lastStartedAt: row.last_started_at, lastSucceededAt: row.last_succeeded_at,
      lastError: row.last_error_code, blocked: row.blocked_reason,
      businessContext,
      alerts,
      activeRun: linked ? publicRun(linked, {
        includeReceipt: false, attempts: this.runAttempts(linked.id),
      }) : null,
      queuedRunCount, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  sync(id, timestamp = nowMs()) {
    return this.readSnapshot(() => this._publicSync(this._syncRow(id), timestamp));
  }

  syncs(limit = 50, offset = 0) {
    return this.readSnapshot(() => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError();
      return this.db.prepare(`SELECT d.*,p.source_id,p.method_id,s.collector_id
        FROM sync_definitions d JOIN plans p ON p.id=d.plan_id JOIN sources s ON s.id=p.source_id
        ORDER BY d.id LIMIT ? OFFSET ?`).all(limit, offset).map(row => this._publicSync(row));
    });
  }

  syncCount() { return this.db.prepare('SELECT COUNT(*) count FROM sync_definitions').get().count; }

  syncHistory(id, limit = 50, offset = 0) {
    return this.readSnapshot(() => {
      this._syncRow(id);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError();
      const items = this.db.prepare(`SELECT sr.generation,sr.config_revision,sr.window_key,sr.trigger,r.*
        FROM sync_runs sr JOIN runs r ON r.id=sr.run_id WHERE sr.sync_id=?
        ORDER BY sr.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(id, limit, offset)
        .map(row => ({ generation: row.generation, configRevision: row.config_revision,
          windowKey: row.window_key, trigger: row.trigger,
          run: publicRun(row, { attempts: this.runAttempts(row.id) }) }));
      const total = this.db.prepare('SELECT COUNT(*) count FROM sync_runs WHERE sync_id=?').get(id).count;
      return { items, total, limit, offset, hasMore: offset + items.length < total };
    });
  }

  dueSyncs(timestamp = nowMs()) {
    return this.db.prepare(`SELECT d.*,p.source_id,p.method_id,s.collector_id
      FROM sync_definitions d JOIN plans p ON p.id=d.plan_id JOIN sources s ON s.id=p.source_id
      WHERE d.desired_state='running' AND d.next_due_at IS NOT NULL AND d.next_due_at<=?
      AND NOT EXISTS(SELECT 1 FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
        WHERE sr.sync_id=d.id AND r.status IN ('queued','running'))
      ORDER BY d.next_due_at,d.id`).all(timestamp).map(row => this._publicSync(row, timestamp));
  }

  setSyncNextDue(id, nextDueAt, timestamp = nowMs()) {
    this._syncRow(id);
    if (nextDueAt !== null && (!Number.isInteger(nextDueAt) || nextDueAt < 0)) throw new ValidationError();
    this.db.prepare('UPDATE sync_definitions SET next_due_at=?,updated_at=? WHERE id=?').run(nextDueAt, timestamp, id);
    return this.sync(id, timestamp);
  }

  setSyncDesiredState(id, desiredState, timestamp = nowMs(), { incrementGeneration = false } = {}) {
    const row = this._syncRow(id);
    if (!['running', 'stopped'].includes(desiredState) || typeof incrementGeneration !== 'boolean') throw new ValidationError('invalid_sync_state');
    const changed = row.desired_state !== desiredState;
    const generation = incrementGeneration && changed && desiredState === 'running' ? row.generation + 1 : row.generation;
    this.db.prepare(`UPDATE sync_definitions SET desired_state=?,generation=?,next_due_at=?,blocked_reason=NULL,updated_at=? WHERE id=?`)
      .run(desiredState, generation, desiredState === 'stopped' ? null : row.next_due_at, timestamp, id);
    return this.sync(id, timestamp);
  }

  enqueueSync(id, { trigger, timestamp = nowMs(), windowKey } = {}) {
    const sync = this.sync(id, timestamp);
    if (sync.desiredState !== 'running' && trigger !== 'sync_manual') throw new StoreError('sync_stopped');
    if (typeof trigger !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(trigger)
        || typeof windowKey !== 'string' || windowKey.length < 1 || windowKey.length > 160
        || !/^[A-Za-z0-9_.:-]+$/.test(windowKey)) throw new ValidationError();
    if (sync.activeRun) {
      // A queued tick explicitly requested by an owner is now manual work,
      // including when retry backoff prevents moving its start time forward.
      if (!this.readOnly && trigger === 'sync_manual' && sync.activeRun.status === 'queued') {
        this.transaction(() => {
          this.db.prepare(`UPDATE sync_runs SET trigger='sync_manual' WHERE run_id=?
            AND EXISTS(SELECT 1 FROM runs WHERE id=sync_runs.run_id AND status='queued')`).run(sync.activeRun.id);
          this.db.prepare("UPDATE runs SET trigger='sync_manual' WHERE id=? AND status='queued'").run(sync.activeRun.id);
        });
      }
      // A manual request can use an unstarted scheduled run immediately.
      // Keep retry backoff and already running work under their existing policy.
      if (trigger === 'sync_manual' && sync.activeRun.status === 'queued'
          && sync.activeRun.attempt === 0 && sync.activeRun.runAfter > timestamp) this.db.prepare(`UPDATE runs SET run_after=?
        WHERE id=? AND status='queued' AND attempt=0 AND run_after>?`)
        .run(timestamp, sync.activeRun.id, timestamp);
      return this.run(sync.activeRun.id);
    }
    const logicalKey = `sync:${id}:${sync.generation}:${windowKey}`;
    const run = this.enqueuePlan(sync.plan, { trigger, input: sync.settings, logicalKey, timestamp });
    this.db.prepare(`INSERT INTO sync_runs(sync_id,run_id,generation,config_revision,window_key,trigger,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(sync_id,generation,window_key) DO NOTHING`)
      .run(id, run.id, sync.generation, sync.revision, windowKey, trigger, timestamp);
    return run;
  }

  stopSyncRuns(id, { cancelActive = true } = {}) {
    this._syncRow(id);
    if (typeof cancelActive !== 'boolean') throw new ValidationError();
    const runs = this.db.prepare(`SELECT r.id,r.status FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
      WHERE sr.sync_id=? AND r.status IN ('queued','running')`).all(id);
    for (const run of runs) {
      if (run.status === 'queued' || cancelActive) this.cancel(run.id);
    }
    return this.sync(id);
  }

  editSync(id, patch, { expectedRevision = null, timestamp = nowMs() } = {}) {
    validateSyncPatch(patch);
    const row = this._syncRow(id);
    if (expectedRevision !== null && row.revision !== expectedRevision) throw new StoreError('sync_revision_conflict');
    const intervalSeconds = patch.intervalSeconds ?? row.interval_seconds;
    const jitterSeconds = patch.jitterSeconds ?? row.jitter_seconds;
    if (jitterSeconds >= intervalSeconds) throw new ValidationError();
    const settings = patch.replaceSettings === true
      ? patch.settings
      : { ...parseJson(row.settings_json), ...(patch.settings || {}) };
    const schema = parseJson(row.settings_schema_json);
    validateAgainstSchema(settings, schema);
    const plan = this.loadPlan(row.plan_id);
    validateAgainstSchema({ ...parseJson(plan.input_json), ...settings }, parseJson(plan.input_schema_json));
    const revision = row.revision + 1;
    const nextDueAt = row.desired_state === 'running' ? timestamp + intervalSeconds * 1000 : null;
    return this.transaction(() => {
      this.db.prepare(`UPDATE sync_definitions SET interval_seconds=?,jitter_seconds=?,settings_json=?,revision=?,next_due_at=?,updated_at=? WHERE id=?`)
        .run(intervalSeconds, jitterSeconds, json(settings), revision, nextDueAt, timestamp, id);
      this.db.prepare(`INSERT INTO sync_revisions(sync_id,revision,interval_seconds,jitter_seconds,settings_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(id, revision, intervalSeconds, jitterSeconds, json(settings), timestamp);
      return this.sync(id, timestamp);
    });
  }

  loadPlan(planId) {
    identifier(planId);
    const row = this.db.prepare(`
      SELECT p.*,s.collector_id,s.auth_profile,s.config_json source_config_json,s.enabled source_enabled,
             c.version collector_version,c.command,c.enabled collector_enabled,
             m.input_schema_json,m.backoff_json,m.concurrency_keys_json
      FROM plans p JOIN sources s ON s.id=p.source_id JOIN collectors c ON c.id=s.collector_id
      JOIN methods m ON m.collector_id=s.collector_id AND m.id=p.method_id WHERE p.id=?
    `).get(planId);
    if (!row) throw new StoreError('plan_not_found');
    if (!require('dispatch-runtime-kit/collection-manager/src/plugin-state').collectorEnabled(this.db, row.collector_id)) row.collector_enabled = 0;
    return row;
  }

  enqueuePlan(planId, {
    trigger = 'manual', input = {}, logicalKey = null, timestamp = nowMs(), runPolicy = null,
  } = {}) {
    const plan = this.loadPlan(planId);
    if (!plan.enabled || !plan.source_enabled || !plan.collector_enabled || !require('dispatch-runtime-kit/collection-manager/src/plugin-state').collectorEnabled(this.db, plan.collector_id)) throw new StoreError('plan_disabled');
    boundedJson(input);
    validateRunPolicy(runPolicy);
    const merged = { ...parseJson(plan.input_json), ...input };
    validateAgainstSchema(merged, parseJson(plan.input_schema_json));
    const id = `run_${crypto.randomUUID().replaceAll('-', '')}`;
    const key = logicalKey || `${planId}:manual:${crypto.randomUUID()}`;
    try {
      this.db.prepare(`
        INSERT INTO runs(id,plan_id,source_id,collector_id,method_id,trigger,logical_key,status,input_json,
          source_config_json,auth_profile,attempt,max_attempts,backoff_json,retry_deadline,retryable_errors_json,
          timeout_seconds,collector_version,command,run_after,cancel_requested,created_at)
        VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?, ?,0,?)
      `).run(id, plan.id, plan.source_id, plan.collector_id, plan.method_id, trigger, key, json(merged),
        plan.source_config_json, plan.auth_profile, 0, runPolicy?.maxAttempts ?? plan.max_attempts,
        json(runPolicy?.backoffSeconds ?? parseJson(plan.backoff_json)), runPolicy?.retryDeadline ?? null,
        runPolicy ? json(runPolicy.retryErrors) : null, plan.timeout_seconds, plan.collector_version,
        plan.command, timestamp, timestamp);
      return this.run(id);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE constraint failed: runs.logical_key')) {
        return this.run(this.db.prepare('SELECT id FROM runs WHERE logical_key=?').get(key).id);
      }
      throw error;
    }
  }

  createBatch(preview, {
    logicalKey = null, trigger = 'manual', timestamp = nowMs(), runPolicy = null,
  } = {}) {
    if (!plainObject(preview) || typeof preview.hash !== 'string' || !/^[a-f0-9]{64}$/.test(preview.hash)
        || !Array.isArray(preview.targets) || !Array.isArray(preview.tasks)) throw new ValidationError();
    validateRunPolicy(runPolicy);
    const request = validateCollectionRequest(preview.request);
    if (logicalKey !== null && (typeof logicalKey !== 'string' || logicalKey.length < 1 || logicalKey.length > 256)) throw new ValidationError();
    const existing = logicalKey ? this.db.prepare('SELECT id FROM collection_batches WHERE logical_key=?').get(logicalKey) : null;
    if (existing) return this.batch(existing.id);
    const id = `batch_${crypto.randomUUID().replaceAll('-', '')}`;
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO collection_batches(id,source_id,scope,request_json,preview_hash,logical_key,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, request.source, request.scope, json(request), preview.hash, logicalKey, timestamp);
      const runsByTargetTask = new Map();
      for (const task of preview.tasks) {
        const key = `${task.targetKey}:${task.taskId}`;
        const run = this.enqueuePlan(task.plan, {
          trigger, input: task.input, timestamp,
          runPolicy: task.dependsOn.length === 0 ? runPolicy : null,
          logicalKey: `batch:${id}:${task.targetKey}:${task.taskId}`,
        });
        this.db.prepare('INSERT INTO batch_runs(batch_id,run_id,target_key,task_id) VALUES(?,?,?,?)')
          .run(id, run.id, task.targetKey, task.taskId);
        runsByTargetTask.set(key, run.id);
        for (const dependency of task.dependsOn) {
          const dependencyRun = runsByTargetTask.get(`${task.targetKey}:${dependency}`);
          if (!dependencyRun) throw new ValidationError('dependency_not_found');
          this.db.prepare('INSERT INTO run_dependencies(run_id,depends_on_run_id) VALUES(?,?)').run(run.id, dependencyRun);
        }
      }
      return this.batch(id);
    });
  }

  batchByLogicalKey(logicalKey) {
    if (typeof logicalKey !== 'string' || logicalKey.length < 1 || logicalKey.length > 256) throw new ValidationError();
    const row = this.db.prepare('SELECT id FROM collection_batches WHERE logical_key=?').get(logicalKey);
    return row ? this.batch(row.id) : null;
  }

  batch(id) {
    identifier(id);
    const summary = this.batchSummary(id);
    const runs = this.db.prepare(`SELECT br.target_key,br.task_id,r.* FROM batch_runs br JOIN runs r ON r.id=br.run_id
      WHERE br.batch_id=? ORDER BY br.target_key,br.task_id`).all(id);
    return {
      ...summary,
      runs: runs.map(run => ({ targetKey: run.target_key, taskId: run.task_id, run: publicRun(run, { includeReceipt: false }) })),
    };
  }

  batchSummary(id) {
    identifier(id);
    const row = this.db.prepare('SELECT * FROM collection_batches WHERE id=?').get(id);
    if (!row) throw new StoreError('batch_not_found');
    const grouped = this.db.prepare(`SELECT r.status,COUNT(*) count FROM batch_runs br JOIN runs r ON r.id=br.run_id
      WHERE br.batch_id=? GROUP BY r.status`).all(id);
    const counts = Object.fromEntries([...RUN_STATUSES].map(status => [status, 0]));
    for (const value of grouped) counts[value.status] = value.count;
    const runCount = Object.values(counts).reduce((total, value) => total + value, 0);
    return {
      id: row.id, source: row.source_id, scope: row.scope, request: parseJson(row.request_json),
      previewHash: row.preview_hash, logicalKey: row.logical_key,
      status: batchStatus(counts, runCount), counts, runCount, createdAt: row.created_at,
    };
  }

  batchPage(id, limit = 50, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError();
    const summary = this.batchSummary(id);
    const items = this.db.prepare(`SELECT br.target_key,br.task_id,r.* FROM batch_runs br JOIN runs r ON r.id=br.run_id
      WHERE br.batch_id=? ORDER BY br.target_key,br.task_id LIMIT ? OFFSET ?`).all(id, limit, offset)
      .map(run => ({ targetKey: run.target_key, taskId: run.task_id, run: publicRun(run, { includeReceipt: false }) }));
    return {
      ...summary,
      runPage: { items, total: summary.runCount, limit, offset, hasMore: offset + items.length < summary.runCount },
    };
  }

  batches(limit = 50, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError();
    return this.db.prepare('SELECT id FROM collection_batches ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => this.batchSummary(row.id));
  }

  batchCount() { return this.db.prepare('SELECT COUNT(*) count FROM collection_batches').get().count; }

  cancelBatch(id) {
    const batch = this.batch(id);
    for (const item of batch.runs) {
      if (['queued', 'running'].includes(item.run.status)) {
        try { this.cancel(item.run.id); } catch (error) { if (error.code !== 'run_not_cancellable') throw error; }
      }
    }
    return this.batch(id);
  }

  retryBatch(id) {
    const batch = this.batch(id);
    const retryable = batch.runs.filter(item => ['failed', 'cancelled'].includes(item.run.status));
    if (retryable.length === 0) throw new StoreError('batch_not_retryable');
    for (const item of retryable) this.retry(item.run.id);
    return this.batch(id);
  }

  run(id) {
    return this.readSnapshot(() => {
      const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
      if (!row) throw new StoreError('run_not_found');
      return publicRun(row, { attempts: this.runAttempts(id) });
    });
  }

  runs(limit = 50, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError();
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => publicRun(row, { includeReceipt: false }));
  }

  runCount() { return this.db.prepare('SELECT COUNT(*) count FROM runs').get().count; }

  queued(timestamp = nowMs(), limit = 100, cursor = null) {
    if (!cursor) return this.db.prepare("SELECT * FROM runs WHERE status='queued' AND run_after<=? ORDER BY run_after,created_at,id LIMIT ?").all(timestamp, limit);
    return this.db.prepare(`SELECT * FROM runs WHERE status='queued' AND run_after<=? AND
      (run_after>? OR (run_after=? AND created_at>?) OR (run_after=? AND created_at=? AND id>?))
      ORDER BY run_after,created_at,id LIMIT ?`).all(timestamp, cursor.run_after, cursor.run_after,
      cursor.created_at, cursor.run_after, cursor.created_at, cursor.id, limit);
  }

  pendingSummary(timestamp = nowMs(), limit = 20) {
    const counts = this.db.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN run_after<=? THEN 1 ELSE 0 END),0) due,
      COALESCE(SUM(CASE WHEN run_after>? THEN 1 ELSE 0 END),0) deferred,
      COALESCE(SUM(CASE WHEN blocked_reason IS NOT NULL THEN 1 ELSE 0 END),0) blocked
      FROM runs WHERE status='queued'`).get(timestamp, timestamp);
    const items = this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY run_after,created_at,id LIMIT ?").all(limit)
      .map(row => publicRun(row, { includeReceipt: false }));
    return { ...counts, items };
  }

  execution(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new StoreError('run_not_found');
    return { ...row, input: parseJson(row.input_json), sourceConfig: parseJson(row.source_config_json),
      backoff: parseJson(row.backoff_json) };
  }

  dependencyStatus(planId, timestamp = nowMs(), runId = null) {
    if (runId) {
      const dependencies = this.db.prepare(`SELECT r.status FROM run_dependencies d JOIN runs r ON r.id=d.depends_on_run_id
        WHERE d.run_id=?`).all(runId);
      if (dependencies.some(item => ['failed', 'cancelled'].includes(item.status))) return { ready: false, terminal: true, reason: 'dependency_failed' };
      if (dependencies.some(item => item.status !== 'succeeded')) return { ready: false, terminal: false, reason: 'dependency_pending' };
    }
    const plan = this.db.prepare('SELECT depends_on_json FROM plans WHERE id=?').get(planId);
    if (!plan) throw new StoreError('plan_not_found');
    for (const dependency of parseJson(plan.depends_on_json)) {
      const latest = this.db.prepare("SELECT finished_at FROM runs WHERE plan_id=? AND status='succeeded' ORDER BY finished_at DESC LIMIT 1").get(dependency.plan);
      if (!latest || latest.finished_at < timestamp - dependency.maxAgeSeconds * 1000) return { ready: false, terminal: false, reason: `dependency:${dependency.plan}` };
    }
    return { ready: true, terminal: false, reason: null };
  }

  expirePollingRun(id, timestamp = nowMs()) {
    const result = this.db.prepare(`UPDATE runs SET status='failed',finished_at=?,error_code='polling_window_expired',
      blocked_reason=NULL WHERE id=? AND status='queued' AND retry_deadline IS NOT NULL AND retry_deadline<=?`)
      .run(timestamp, id, timestamp);
    return result.changes === 1;
  }

  failDependency(id, timestamp = nowMs()) {
    this.db.prepare("UPDATE runs SET status='failed',finished_at=?,error_code='dependency_failed',blocked_reason='dependency_failed' WHERE id=? AND status='queued'")
      .run(timestamp, id);
    return this.run(id);
  }

  setCapacityWait(id, reason, fence) {
    if (![null, 'waiting_for_capacity'].includes(reason)) throw new StoreError('invalid_input');
    this.assertManagerLease(fence.instanceId, fence.epoch);
    this.db.prepare("UPDATE runs SET started_at=CASE WHEN blocked_reason='waiting_for_capacity' AND ? IS NULL THEN ? ELSE started_at END, blocked_reason=? WHERE id=? AND status='running'")
      .run(reason, nowMs(), reason, id);
  }

  setBlocked(id, reason) {
    this.db.prepare("UPDATE runs SET blocked_reason=? WHERE id=? AND status='queued'").run(reason, id);
  }

  assertManagerLease(instanceId, epoch, timestamp = nowMs()) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='manager_lease'").get();
    const lease = row ? parseJson(row.value) : null;
    if (!lease || lease.instanceId !== instanceId || lease.epoch !== epoch || lease.expiresAt <= timestamp) {
      throw new StoreError('manager_lease_lost');
    }
    return lease;
  }

  claimRun(id, keys, timestamp = nowMs(), manager = null) {
    return this.transaction(() => {
      if (manager) this.assertManagerLease(manager.instanceId, manager.epoch, timestamp);
      const row = this.db.prepare("SELECT status,collector_id FROM runs WHERE id=?").get(id);
      if (!row || row.status !== 'queued' || !require('dispatch-runtime-kit/collection-manager/src/plugin-state').collectorEnabled(this.db, row.collector_id)) return false;
      try {
        for (const key of keys) this.db.prepare('INSERT INTO run_locks(key,run_id) VALUES(?,?)').run(key, id);
      } catch (error) {
        if (String(error?.message).includes('UNIQUE constraint failed')) throw new StoreError('lock_busy');
        throw error;
      }
      const result = this.db.prepare(`UPDATE runs SET status='running',attempt=attempt+1,started_at=?,finished_at=NULL,
        exit_code=NULL,receipt_json=NULL,error_code=NULL,blocked_reason=NULL,cancel_requested=0 WHERE id=? AND status='queued'`).run(timestamp, id);
      if (result.changes !== 1) throw new StoreError('run_not_queued');
      const claimed = this.db.prepare('SELECT attempt FROM runs WHERE id=?').get(id);
      this.db.prepare(`INSERT INTO run_attempts(
        run_id,attempt,status,started_at,finished_at,exit_code,error_code
      ) VALUES(?,?,'running',?,NULL,NULL,NULL)`).run(id, claimed.attempt, timestamp);
      this.db.prepare(`UPDATE sync_definitions SET last_started_at=?,updated_at=? WHERE id=(
        SELECT sync_id FROM sync_runs WHERE run_id=?)`).run(timestamp, timestamp, id);
      return true;
    });
  }

  finishRun(id, outcome, timestamp = nowMs(), manager = null) {
    return this.transaction(() => {
      if (manager) this.assertManagerLease(manager.instanceId, manager.epoch, timestamp);
      const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
      if (!row || row.status !== 'running') throw new StoreError('run_not_running');
      const linkedSync = this.db.prepare('SELECT sync_id FROM sync_runs WHERE run_id=?').get(id) || null;
      this.db.prepare('DELETE FROM run_locks WHERE run_id=?').run(id);
      const cancelled = Boolean(outcome.cancelled || row.cancel_requested);
      const attemptStatus = cancelled ? 'cancelled' : outcome.success ? 'succeeded' : 'failed';
      const attemptError = attemptStatus === 'succeeded' ? null
        : cancelled ? 'cancelled' : outcome.errorCode || 'collector_failed';
      if (attemptError !== null && (typeof attemptError !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(attemptError))) {
        throw new StoreError('invalid_attempt_diagnostic');
      }
      const attemptResult = this.db.prepare(`UPDATE run_attempts SET
        status=?,finished_at=?,exit_code=?,error_code=? WHERE run_id=? AND attempt=? AND status='running'`)
        .run(attemptStatus, timestamp, outcome.exitCode ?? null, attemptError, id, row.attempt);
      if (attemptResult.changes !== 1) throw new StoreError('attempt_not_running');
      if (cancelled) {
        this.db.prepare("UPDATE runs SET status='cancelled',finished_at=?,exit_code=?,error_code='cancelled',cancel_requested=0 WHERE id=?")
          .run(timestamp, outcome.exitCode ?? null, id);
      } else if (outcome.success) {
        boundedJson(outcome.receipt, { maxBytes: 65_536 });
        this.db.prepare("UPDATE runs SET status='succeeded',finished_at=?,exit_code=?,receipt_json=?,error_code=NULL WHERE id=?")
          .run(timestamp, outcome.exitCode ?? 0, json(outcome.receipt), id);
      } else {
        const backoff = parseJson(row.backoff_json);
        const delay = backoff[Math.min(row.attempt - 1, Math.max(0, backoff.length - 1))] || 0;
        const nextRunAt = timestamp + delay * 1000;
        const retryErrors = row.retryable_errors_json === null ? null : parseJson(row.retryable_errors_json);
        const terminalAuthentication = Boolean(linkedSync && AUTH_ERRORS.has(attemptError));
        const retryable = !terminalAuthentication && (retryErrors === null || retryErrors.includes(attemptError));
        const beforeDeadline = row.retry_deadline === null || nextRunAt < row.retry_deadline;
        if (row.attempt < row.max_attempts && retryable && beforeDeadline) {
          this.db.prepare("UPDATE runs SET status='queued',run_after=?,finished_at=NULL,exit_code=?,error_code=?,blocked_reason=NULL WHERE id=?")
            .run(nextRunAt, outcome.exitCode ?? null, attemptError, id);
        } else {
          const finalError = retryable && row.retry_deadline !== null && !beforeDeadline
            ? 'polling_window_expired' : attemptError;
          this.db.prepare("UPDATE runs SET status='failed',finished_at=?,exit_code=?,error_code=? WHERE id=?")
            .run(timestamp, outcome.exitCode ?? null, finalError, id);
        }
      }
      const completed = this.db.prepare('SELECT status,error_code FROM runs WHERE id=?').get(id);
      if (completed.status === 'succeeded') {
        this.db.prepare(`UPDATE sync_definitions SET last_succeeded_at=?,last_error_code=NULL,blocked_reason=NULL,updated_at=?
          WHERE id=?`).run(timestamp, timestamp, linkedSync?.sync_id || '');
      } else if (['failed', 'cancelled'].includes(completed.status)) {
        if (completed.status === 'failed' && linkedSync && AUTH_ERRORS.has(completed.error_code)) {
          this.db.prepare(`UPDATE sync_definitions SET last_error_code=?,blocked_reason=?,
            next_due_at=CASE WHEN desired_state='running' THEN MAX(COALESCE(next_due_at,0),?) ELSE next_due_at END,
            updated_at=? WHERE id=?`)
            .run(completed.error_code, completed.error_code, timestamp + AUTH_BLOCK_PROBE_MS, timestamp, linkedSync.sync_id);
        } else {
          this.db.prepare(`UPDATE sync_definitions SET last_error_code=?,updated_at=?
            WHERE id=?`).run(completed.error_code, timestamp, linkedSync?.sync_id || '');
        }
      }
      if (completed.status === 'succeeded') {
        try { this._compactHistory(Math.max(0, timestamp - NO_CHANGE_RETENTION_MS), MAX_COMPACTION_DELETE); } catch {}
      }
      return this.run(id);
    });
  }

  cancel(id) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT status,collector_id FROM runs WHERE id=?').get(id);
      if (!row) throw new StoreError('run_not_found');
      if (row.status === 'queued') {
        this.db.prepare("UPDATE runs SET status='cancelled',finished_at=?,error_code='cancelled' WHERE id=?").run(nowMs(), id);
        this.db.prepare('DELETE FROM run_locks WHERE run_id=?').run(id);
      } else if (row.status === 'running') this.db.prepare('UPDATE runs SET cancel_requested=1 WHERE id=?').run(id);
      else throw new StoreError('run_not_cancellable');
      return this.run(id);
    });
  }

  retry(id) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT status,attempt,max_attempts FROM runs WHERE id=?').get(id);
      if (!row) throw new StoreError('run_not_found');
      if (!['failed', 'cancelled'].includes(row.status)) throw new StoreError('run_not_retryable');
      this.db.prepare(`UPDATE runs SET status='queued',run_after=?,finished_at=NULL,error_code=NULL,blocked_reason=NULL,
        cancel_requested=0,max_attempts=?,retry_deadline=NULL,retryable_errors_json=NULL WHERE id=?`)
        .run(nowMs(), Math.max(row.max_attempts, row.attempt + 1), id);
      return this.run(id);
    });
  }

  collectionSchedules() {
    return this.db.prepare('SELECT * FROM collection_schedules ORDER BY id').all().map(publicCollectionSchedule);
  }

  collectionSchedule(id) {
    identifier(id);
    const row = this.db.prepare('SELECT * FROM collection_schedules WHERE id=?').get(id);
    if (!row) throw new StoreError('schedule_not_found');
    return publicCollectionSchedule(row);
  }

  putCollectionSchedule(value, timestamp = nowMs()) {
    validateCollectionSchedule(value);
    this.sourceRuntime(value.request.source, { allowDisabled: value.enabled === false });
    const existing = this.db.prepare('SELECT schedule_json,next_due_at,created_at FROM collection_schedules WHERE id=?').get(value.id);
    const scheduleJson = json(value.schedule);
    let nextDue = existing?.next_due_at ?? null;
    if (!existing || existing.schedule_json !== scheduleJson) nextDue = value.schedule.type === 'interval' ? timestamp + value.schedule.seconds * 1000 : null;
    this.db.prepare(`INSERT INTO collection_schedules(id,request_json,schedule_json,enabled,next_due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET request_json=excluded.request_json,
      schedule_json=excluded.schedule_json,enabled=excluded.enabled,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at`)
      .run(value.id, json(validateCollectionRequest(value.request)), scheduleJson, Number(value.enabled), nextDue, existing?.created_at ?? timestamp, timestamp);
    return this.collectionSchedule(value.id);
  }

  setCollectionScheduleEnabled(id, enabled) {
    identifier(id);
    if (typeof enabled !== 'boolean') throw new ValidationError();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT request_json FROM collection_schedules WHERE id=?').get(id);
      if (!row) throw new StoreError('schedule_not_found');
      if (enabled) this.sourceRuntime(parseJson(row.request_json).source);
      this.db.prepare('UPDATE collection_schedules SET enabled=?,updated_at=? WHERE id=?').run(Number(enabled), nowMs(), id);
      return this.collectionSchedule(id);
    });
  }

  removeCollectionSchedule(id) {
    const schedule = this.collectionSchedule(id);
    this.db.prepare('DELETE FROM collection_schedules WHERE id=?').run(id);
    return schedule;
  }

  schedulableCollectionSchedules() {
    return this.db.prepare('SELECT * FROM collection_schedules WHERE enabled=1 ORDER BY id').all().map(publicCollectionSchedule);
  }

  setCollectionScheduleNextDue(id, timestamp) {
    this.db.prepare('UPDATE collection_schedules SET next_due_at=?,updated_at=? WHERE id=?').run(timestamp, nowMs(), id);
  }

  setPlanEnabled(id, enabled) {
    identifier(id);
    const result = this.db.prepare('UPDATE plans SET enabled=?,updated_at=? WHERE id=?').run(Number(enabled), nowMs(), id);
    if (result.changes !== 1) throw new StoreError('plan_not_found');
    return publicPlan(this.db.prepare('SELECT * FROM plans WHERE id=?').get(id));
  }

  schedulablePlans() {
    return this.db.prepare(`SELECT p.* FROM plans p JOIN sources s ON s.id=p.source_id
      JOIN collectors c ON c.id=s.collector_id WHERE p.enabled=1 AND s.enabled=1 AND c.enabled=1 ORDER BY p.id`).all()
      .filter(row => require('dispatch-runtime-kit/collection-manager/src/plugin-state').collectorEnabled(this.db, this.loadPlan(row.id).collector_id)).map(publicPlan);
  }
  setNextDue(id, timestamp) { this.db.prepare('UPDATE plans SET next_due_at=? WHERE id=?').run(timestamp, id); }

  cancelRequestedRuns() { return this.db.prepare("SELECT id FROM runs WHERE status='running' AND cancel_requested=1").all().map(row => row.id); }

  recoverRunning(timestamp = nowMs()) {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id,attempt,max_attempts,backoff_json,retry_deadline,started_at FROM runs WHERE status='running'").all();
      for (const row of rows) {
        this.db.prepare(`INSERT INTO run_attempts(
          run_id,attempt,status,started_at,finished_at,exit_code,error_code
        ) VALUES(?,?,'interrupted',?,?,NULL,'manager_restarted')
        ON CONFLICT(run_id,attempt) DO UPDATE SET
          status='interrupted',finished_at=excluded.finished_at,error_code='manager_restarted'`)
          .run(row.id, row.attempt, row.started_at || timestamp, timestamp);
        const backoff = parseJson(row.backoff_json);
        const delay = backoff[Math.min(row.attempt - 1, Math.max(0, backoff.length - 1))] || 0;
        const nextRunAt = timestamp + delay * 1000;
        if (row.attempt < row.max_attempts && (row.retry_deadline === null || nextRunAt < row.retry_deadline)) {
          this.db.prepare("UPDATE runs SET status='queued',run_after=?,finished_at=NULL,error_code='manager_restarted',blocked_reason=NULL WHERE id=?")
            .run(nextRunAt, row.id);
        } else {
          const error = row.retry_deadline !== null && nextRunAt >= row.retry_deadline
            ? 'polling_window_expired' : 'manager_restarted';
          this.db.prepare("UPDATE runs SET status='failed',finished_at=?,error_code=? WHERE id=?").run(timestamp, error, row.id);
        }
      }
      this.db.exec('DELETE FROM run_locks');
      return rows.length;
    });
  }

  claimManager(instanceId, pid, timestamp, leaseMs) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='manager_lease'").get();
      if (row) {
        const lease = parseJson(row.value);
        if (lease.expiresAt > timestamp && lease.instanceId !== instanceId) throw new StoreError('manager_already_running');
      }
      const epochRow = this.db.prepare("SELECT value FROM meta WHERE key='manager_epoch'").get();
      const epoch = epochRow ? Number(epochRow.value) + 1 : 1;
      this.db.prepare("INSERT INTO meta(key,value) VALUES('manager_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(epoch));
      const value = json({ instanceId, pid, epoch, expiresAt: timestamp + leaseMs, heartbeatAt: timestamp });
      this.db.prepare("INSERT INTO meta(key,value) VALUES('manager_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
      return epoch;
    });
  }

  renewManager(instanceId, pid, epoch, timestamp, leaseMs) {
    return this.transaction(() => {
      this.assertManagerLease(instanceId, epoch, timestamp);
      this.db.prepare("UPDATE meta SET value=? WHERE key='manager_lease'")
        .run(json({ instanceId, pid, epoch, expiresAt: timestamp + leaseMs, heartbeatAt: timestamp }));
    });
  }

  releaseManager(instanceId, epoch) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='manager_lease'").get();
      const lease = row ? parseJson(row.value) : null;
      if (lease && lease.instanceId === instanceId && lease.epoch === epoch) this.db.prepare("DELETE FROM meta WHERE key='manager_lease'").run();
    });
  }

  _compactHistory(before, maxDelete) {
    const candidates = this.db.prepare(`SELECT r.id,r.finished_at,r.collector_version,r.receipt_json,sr.sync_id
      FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
      WHERE r.status='succeeded' AND r.finished_at<? ORDER BY r.finished_at DESC,r.id DESC LIMIT 5000`).all(before);
    const kept = new Set();
    const deletions = [];
    for (const row of candidates) {
      let receipt;
      try { receipt = JSON.parse(row.receipt_json); } catch { continue; }
      const noChange = receipt?.status === 'no_change' || receipt?.data?.disposition === 'no_change';
      if (!noChange) continue;
      const businessDate = typeof receipt?.data?.businessDate === 'string' ? receipt.data.businessDate
        : typeof receipt?.data?.persistence?.date === 'string' ? receipt.data.persistence.date
          : new Date(row.finished_at).toISOString().slice(0, 10);
      const key = `${row.sync_id}:${row.collector_version}:${businessDate}`;
      if (!kept.has(key)) { kept.add(key); continue; }
      deletions.push(row.id);
      if (deletions.length >= maxDelete) break;
    }
    const remove = this.db.prepare('DELETE FROM runs WHERE id=?');
    let deleted = 0;
    for (const id of deletions) deleted += remove.run(id).changes;
    return { scanned: candidates.length, deleted };
  }

  compactHistory(before = nowMs() - NO_CHANGE_RETENTION_MS, maxDelete = MAX_COMPACTION_DELETE) {
    if (!Number.isInteger(before) || before < 0 || !Number.isInteger(maxDelete) || maxDelete < 1 || maxDelete > 1000) {
      throw new ValidationError();
    }
    return this.transaction(() => this._compactHistory(before, maxDelete));
  }

  health(timestamp = nowMs()) {
    const quick = this.db.prepare('PRAGMA quick_check').get().quick_check;
    const counts = {
      collectors: this.db.prepare('SELECT COUNT(*) count FROM collectors WHERE enabled=1').get().count,
      sources: this.db.prepare('SELECT COUNT(*) count FROM sources WHERE enabled=1').get().count,
      plans: this.db.prepare('SELECT COUNT(*) count FROM plans WHERE enabled=1').get().count,
      schedules: this.db.prepare('SELECT COUNT(*) count FROM collection_schedules WHERE enabled=1').get().count,
      batches: this.db.prepare('SELECT COUNT(*) count FROM collection_batches').get().count,
      syncs: this.db.prepare('SELECT COUNT(*) count FROM sync_definitions').get().count,
      syncing: this.db.prepare(`SELECT COUNT(*) count FROM sync_runs sr JOIN runs r ON r.id=sr.run_id
        WHERE r.status='running'`).get().count,
      queued: this.db.prepare("SELECT COUNT(*) count FROM runs WHERE status='queued'").get().count,
      running: this.db.prepare("SELECT COUNT(*) count FROM runs WHERE status='running'").get().count,
      failed: this.db.prepare("SELECT COUNT(*) count FROM runs WHERE status='failed'").get().count,
    };
    const row = this.db.prepare("SELECT value FROM meta WHERE key='manager_lease'").get();
    const lease = row ? parseJson(row.value) : null;
    const manager = lease && lease.expiresAt > timestamp ? { running: true, pid: lease.pid, heartbeatAt: lease.heartbeatAt } : { running: false, pid: null, heartbeatAt: lease?.heartbeatAt ?? null };
    const alertItems = this.db.prepare(`SELECT d.*,p.source_id,p.method_id,s.collector_id
      FROM sync_definitions d JOIN plans p ON p.id=d.plan_id JOIN sources s ON s.id=p.source_id
      WHERE d.desired_state='running' ORDER BY d.id`).all()
      .flatMap(sync => this._publicSync(sync, timestamp).alerts.map(alert => ({
        syncId: sync.id, code: alert.code, severity: alert.severity,
      })));
    const visibleAlerts = alertItems.slice(0, 100);
    const syncAlerts = {
      total: alertItems.length,
      critical: alertItems.filter(alert => alert.severity === 'critical').length,
      items: visibleAlerts,
      hasMore: visibleAlerts.length < alertItems.length,
    };
    const status = quick !== 'ok' ? 'failed' : !manager.running ? 'stopped' : syncAlerts.total ? 'degraded' : 'ready';
    return { ok: quick === 'ok', status, schemaVersion: SCHEMA_VERSION, databaseIntegrity: quick, manager, counts, syncAlerts };
  }
}

module.exports = {
  CollectionStore, StoreError, SCHEMA_VERSION, RUN_STATUSES,
  ensurePrivateDirectory, safeRegularFile, safeExecutable, publicRun,
};
