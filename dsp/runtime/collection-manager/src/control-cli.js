'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');
const { parseStrictJson } = require('dispatch-runtime-kit/collection-manager/src/strict-json');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('./manager');
const { StandardCollectionService } = require('dispatch-runtime-kit/collection-manager/src/standard-collections');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');

const SAFE_ERRORS = new Set([
  'invalid_input', 'invalid_json', 'secret_field_forbidden', 'unsafe_storage', 'unsafe_collector',
  'collector_unavailable', 'collector_not_found', 'source_not_found', 'method_not_found',
  'dependency_not_found', 'dependency_cycle', 'plan_not_found', 'plan_disabled', 'run_not_found', 'run_not_cancellable',
  'run_not_retryable', 'manager_already_running', 'manager_lease_lost', 'drain_timeout',
  'input_not_found', 'input_unreadable', 'database_integrity_failed', 'schema_invalid',
  'collection_capabilities_not_found', 'unsupported_selector', 'unsupported_scope', 'invalid_selector',
  'invalid_collection_request', 'invalid_target_resolution', 'invalid_timezone', 'target_resolution_failed', 'range_too_large',
  'preview_changed', 'idempotency_conflict', 'audit_not_supported', 'batch_not_found', 'batch_not_retryable', 'schedule_not_found', 'invalid_schedule',
  'sync_not_found', 'sync_stopped', 'invalid_sync_state', 'sync_revision_conflict', 'sync_stop_timeout',
  'sync_plan_must_be_manual', 'sync_config_incompatible', 'unsupported_overlap_policy',
  'collection_manager_not_initialized',
]);

const READ_ONLY_COMMANDS = new Set([
  'status', 'collectors', 'collector', 'methods', 'sources', 'source', 'plans', 'plan',
  'runs', 'run-status', 'collection-describe', 'collection-preview', 'batches', 'batch',
  'collection-schedules', 'syncs', 'sync', 'sync-history',
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readJsonFile(file, maxBytes = 262_144) {
  const resolved = path.resolve(file);
  let info;
  try { info = fs.lstatSync(resolved); }
  catch (error) { throw codedError(error?.code === 'ENOENT' ? 'input_not_found' : 'input_unreadable'); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.size < 2 || info.size > maxBytes
      || fs.realpathSync(resolved) !== resolved) throw codedError('invalid_input');
  try { return parseStrictJson(fs.readFileSync(resolved, 'utf8')); }
  catch (error) {
    if (error?.code === 'invalid_json') throw error;
    throw codedError('input_unreadable');
  }
}

const PROJECT_COMMAND_PREFIX = '${DISPATCH_PROJECT_ROOT}/';
function materializeSpec(value, projectRoot) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.collectors)
      || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot) {
    throw codedError('invalid_input');
  }
  for (const collector of value.collectors) {
    if (typeof collector?.command !== 'string' || !collector.command.startsWith(PROJECT_COMMAND_PREFIX)) continue;
    const relative = collector.command.slice(PROJECT_COMMAND_PREFIX.length);
    const resolved = path.resolve(projectRoot, relative);
    if (!relative || resolved === projectRoot || !resolved.startsWith(`${projectRoot}${path.sep}`)) throw codedError('invalid_input');
    collector.command = resolved;
  }
  return value;
}

function emit(write, ok, status, data = null) {
  write(`${JSON.stringify({ ok, status, data })}\n`);
}

function page(items, args) {
  if (args.length > 2) throw codedError('invalid_input');
  const limit = args[0] === undefined ? 50 : Number(args[0]);
  const offset = args[1] === undefined ? 0 : Number(args[1]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw codedError('invalid_input');
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset, hasMore: offset + limit < items.length };
}

const HELP = Object.freeze({
  commands: [
    'status', 'collectors [limit] [offset]', 'collector <id>', 'methods <collector> [limit] [offset]',
    'sources [limit] [offset]', 'source <id>', 'plans [limit] [offset]', 'plan <id>',
    'runs [limit] [offset]', 'run-status <run-id>', 'run <plan-id> [input.json]',
    'pause <plan-id>', 'resume <plan-id>', 'cancel <run-id>', 'retry <run-id>',
    'apply <spec.json>', 'drain [timeout-ms]', 'init',
    'collection-describe <source>', 'collection-preview <request.json>',
    'collection-enqueue <request.json> [options.json]', 'batches [limit] [offset]', 'batch <batch-id>',
    'cancel-batch <batch-id>', 'retry-batch <batch-id>', 'collection-schedules', 'put-collection-schedule <schedule.json>',
    'pause-collection-schedule <id>', 'resume-collection-schedule <id>', 'remove-collection-schedule <id>', 'run-collection-schedule <id>',
    'syncs [limit] [offset]', 'sync <id>', 'start-sync <id>', 'stop-sync <id>', 'restart-sync <id>',
    'run-sync <id>', 'edit-sync <id> <patch.json>', 'sync-history <id> [limit] [offset]',
  ],
});

async function main(argv = process.argv.slice(2), paths = defaultPaths(), write = chunk => process.stdout.write(chunk)) {
  process.umask(0o077);
  let store;
  let manager;
  try {
    const [command, ...args] = argv;
    if (command === 'help' && args.length === 0) { emit(write, true, 'help', HELP); return 0; }
    if (command === 'status' && args.length === 0 && !fs.existsSync(paths.database)) {
      emit(write, true, 'not_initialized', {
        ok: true, status: 'not_initialized', schemaVersion: null, databaseIntegrity: 'not_initialized',
        manager: { running: false, pid: null, heartbeatAt: null },
        counts: { collectors: 0, sources: 0, plans: 0, schedules: 0, batches: 0, syncs: 0, syncing: 0, queued: 0, running: 0, failed: 0 },
        syncAlerts: { total: 0, critical: 0, items: [], hasMore: false },
      });
      return 0;
    }
    if (READ_ONLY_COMMANDS.has(command) && !fs.existsSync(paths.database)) throw codedError('collection_manager_not_initialized');
    store = new CollectionStore(paths, { readOnly: READ_ONLY_COMMANDS.has(command) });
    if (command === 'init' && args.length === 0) emit(write, true, 'initialized', store.health());
    else if (command === 'apply' && args.length === 1) {
      emit(write, true, 'applied', store.applySpec(materializeSpec(readJsonFile(args[0]), paths.projectRoot)));
    }
    else if (command === 'status' && args.length === 0) {
      const health = store.health();
      emit(write, health.ok, health.status, health);
    }
    else if (command === 'collectors') emit(write, true, 'found', page(store.collectors(), args));
    else if (command === 'collector' && args.length === 1) emit(write, true, 'found', store.collector(args[0]));
    else if (command === 'methods' && args.length >= 1 && args.length <= 3) emit(write, true, 'found', page(store.methods(args[0]), args.slice(1)));
    else if (command === 'sources') emit(write, true, 'found', page(store.sources(), args));
    else if (command === 'source' && args.length === 1) emit(write, true, 'found', store.source(args[0]));
    else if (command === 'plans') emit(write, true, 'found', page(store.plans(), args));
    else if (command === 'plan' && args.length === 1) emit(write, true, 'found', store.plan(args[0]));
    else if (command === 'runs' && args.length <= 2) {
      const limit = args[0] === undefined ? 50 : Number(args[0]);
      const offset = args[1] === undefined ? 0 : Number(args[1]);
      const items = store.runs(limit, offset);
      const total = store.runCount();
      emit(write, true, 'found', { items, total, limit, offset, hasMore: offset + limit < total });
    }
    else if (command === 'collection-describe' && args.length === 1) {
      emit(write, true, 'found', new StandardCollectionService(store).describe(args[0]));
    }
    else if (command === 'collection-preview' && args.length === 1) {
      emit(write, true, 'previewed', await new StandardCollectionService(store).preview(readJsonFile(args[0], 65_536)));
    }
    else if (command === 'collection-enqueue' && (args.length === 1 || args.length === 2)) {
      const options = args[1] ? readJsonFile(args[1], 16_384) : {};
      if (!options || typeof options !== 'object' || Array.isArray(options)
          || Object.keys(options).some(key => !['expectedPreviewHash', 'idempotencyKey'].includes(key))) throw codedError('invalid_input');
      emit(write, true, 'queued', await new StandardCollectionService(store).enqueue(readJsonFile(args[0], 65_536), options));
    }
    else if (command === 'batches' && args.length <= 2) {
      const limit = args[0] === undefined ? 50 : Number(args[0]);
      const offset = args[1] === undefined ? 0 : Number(args[1]);
      const items = store.batches(limit, offset); const total = store.batchCount();
      emit(write, true, 'found', { items, total, limit, offset, hasMore: offset + limit < total });
    }
    else if (command === 'batch' && args.length === 1) { const batch = store.batch(args[0]); emit(write, true, batch.status, batch); }
    else if (command === 'cancel-batch' && args.length === 1) { const batch = store.cancelBatch(args[0]); emit(write, true, batch.status, batch); }
    else if (command === 'retry-batch' && args.length === 1) { const batch = store.retryBatch(args[0]); emit(write, true, batch.status, batch); }
    else if (command === 'collection-schedules' && args.length === 0) emit(write, true, 'found', { items: store.collectionSchedules() });
    else if (command === 'put-collection-schedule' && args.length === 1) emit(write, true, 'scheduled', new StandardCollectionService(store).putSchedule(readJsonFile(args[0], 65_536)));
    else if (command === 'pause-collection-schedule' && args.length === 1) emit(write, true, 'paused', store.setCollectionScheduleEnabled(args[0], false));
    else if (command === 'resume-collection-schedule' && args.length === 1) emit(write, true, 'resumed', store.setCollectionScheduleEnabled(args[0], true));
    else if (command === 'remove-collection-schedule' && args.length === 1) emit(write, true, 'removed', store.removeCollectionSchedule(args[0]));
    else if (command === 'run-collection-schedule' && args.length === 1) emit(write, true, 'queued', await new StandardCollectionService(store).runScheduleNow(args[0]));
    else if (command === 'syncs' && args.length <= 2) {
      const limit = args[0] === undefined ? 50 : Number(args[0]);
      const offset = args[1] === undefined ? 0 : Number(args[1]);
      const items = store.syncs(limit, offset); const total = store.syncCount();
      emit(write, true, 'found', { items, total, limit, offset, hasMore: offset + items.length < total });
    }
    else if (command === 'sync' && args.length === 1) emit(write, true, 'found', store.sync(args[0]));
    else if (command === 'start-sync' && args.length === 1) emit(write, true, 'started', new SyncService(store).start(args[0]));
    else if (command === 'stop-sync' && args.length === 1) emit(write, true, 'stopped', await new SyncService(store).stop(args[0]));
    else if (command === 'restart-sync' && args.length === 1) emit(write, true, 'restarted', await new SyncService(store).restart(args[0]));
    else if (command === 'run-sync' && args.length === 1) emit(write, true, 'queued', new SyncService(store).runNow(args[0]));
    else if (command === 'edit-sync' && args.length === 2) emit(write, true, 'updated', await new SyncService(store).edit(args[0], readJsonFile(args[1], 16_384)));
    else if (command === 'sync-history' && args.length >= 1 && args.length <= 3) {
      const limit = args[1] === undefined ? 50 : Number(args[1]);
      const offset = args[2] === undefined ? 0 : Number(args[2]);
      emit(write, true, 'found', store.syncHistory(args[0], limit, offset));
    }
    else if (command === 'run-status' && args.length === 1) {
      const run = store.run(args[0]);
      emit(write, true, run.status, run);
    }
    else if (command === 'run' && (args.length === 1 || args.length === 2)) {
      const input = args[1] ? readJsonFile(args[1], 65_536) : {};
      emit(write, true, 'queued', store.enqueuePlan(args[0], { input }));
    } else if (command === 'pause' && args.length === 1) emit(write, true, 'paused', store.setPlanEnabled(args[0], false));
    else if (command === 'resume' && args.length === 1) emit(write, true, 'resumed', store.setPlanEnabled(args[0], true));
    else if (command === 'cancel' && args.length === 1) {
      const run = store.cancel(args[0]);
      emit(write, true, run.status, run);
    }
    else if (command === 'retry' && args.length === 1) emit(write, true, 'queued', store.retry(args[0]));
    else if (command === 'drain' && args.length <= 1) {
      const timeoutMs = args[0] === undefined ? 30_000 : Number(args[0]);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw codedError('invalid_input');
      manager = new CollectionManager(store);
      await manager.start();
      const result = await manager.runUntilIdle({ timeoutMs });
      const stopped = await manager.stop();
      const data = { ...result, ...stopped, health: store.health() };
      if (result.timedOut) {
        emit(write, false, 'drain_timeout', data);
        return 1;
      }
      emit(write, true, result.deferred ? 'deferred' : 'idle', data);
    } else throw codedError('invalid_input');
    return 0;
  } catch (error) {
    try { await manager?.stop(); } catch {}
    const code = SAFE_ERRORS.has(error?.code) ? error.code : SAFE_ERRORS.has(error?.message) ? error.message : 'internal_error';
    emit(write, false, code);
    return ['invalid_input', 'invalid_json', 'input_not_found', 'input_unreadable'].includes(code) ? 2 : 1;
  } finally {
    store?.close();
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main, readJsonFile, materializeSpec, PROJECT_COMMAND_PREFIX };
