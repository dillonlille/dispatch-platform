'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');
const control = require('dispatch-runtime-kit/collection-manager/src/execution-control');
const { resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');
const { gatewayPlugin } = require('dispatch-protocol/plugin-sdk/catalog');
const { available } = require('../core/accounts/src/plugins');
const { ACTIVE_STATES, BACKEND } = require('../host/controller/access-authority');
const { success, failure } = require('dispatch-protocol/contracts/src/result');

// Offline only: callers hold BOTH controller and operation locks, and every
// affected DSP service must have stopped. No provider requests are executed.
// The handoff is replayable across two SQLite databases: the DSP logical key
// commits first, then Core acknowledges it. Never restore database backups over
// work accepted since deployment.
async function restore({ execution, access, journal, host, checkedDsp, lockFd, afterDelivery = () => {} }) {
  const rows = execution.db.prepare('SELECT * FROM dsp_execution ORDER BY runtime_key').all();
  for (const row of rows) {
    const state = await host.state(row.runtime_key, lockFd);
    if (state.active || state.pid || !['inactive', 'failed'].includes(state.status)) throw new Error('execution_rollback_requires_stopped_dsps');
  }
  const receipt = { restored: 0, delivered: 0, rejected: 0 };
  for (const row of rows) {
    const record = journal.record(row.runtime_key), dsp = checkedDsp(record);
    const collection = new CollectionStore(resolveLocalRuntimePaths({ localRoot: dsp.root }).collection);
    try {
      if (collection.db.prepare("SELECT 1 FROM runs WHERE status='running'").get()) throw new Error('execution_rollback_requires_idle_runs');
      const installation = access.db.prepare('SELECT i.*,o.status organization_status FROM installations i JOIN organizations o ON o.id=i.organization_id WHERE i.runtime_key=?').get(row.runtime_key);
      if (!installation || installation.organization_id !== row.organization_id || installation.backend !== BACKEND) throw new Error('runtime_identity_mismatch');
      const permitted = ACTIVE_STATES.includes(installation.status) && ['pending_owner', 'setup_required', 'active'].includes(installation.organization_status)
        && !access.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(row.organization_id)
        && !access.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id);
      const pending = execution.db.prepare("SELECT * FROM dsp_work WHERE runtime_key=? AND status IN ('queued','dispatching') ORDER BY created_at,id").all(row.runtime_key);
      for (const job of pending) {
        const input = JSON.parse(job.input_json), plugin = gatewayPlugin(job.action, input);
        let result;
        if (!permitted) result = failure('execution_not_permitted');
        else if (plugin && !available(access, row.organization_id, plugin.id)) result = failure('plugin_disabled');
        else {
          if (job.action !== 'sync.run_now' || input.options.idempotencyKey !== job.idempotency_key) throw new Error('execution_rollback_invalid_job');
          try { new SyncService(collection).runNow(input.id, { idempotencyKey: job.idempotency_key }); result = success('queued', {}); }
          catch (error) {
            if (!['sync_stopped', 'plan_disabled', 'sync_not_found'].includes(error.code)) throw error;
            result = failure(error.code);
          }
        }
        afterDelivery(job, result);
        execution.finish(job, result, Date.now());
        receipt[result.ok ? 'delivered' : 'rejected']++;
      }
      control.command(collection, 'restore');
      if (permitted && record.desiredState !== 'retired') journal.saveRecord({ ...record, desiredState: 'running' });
      execution.update(row.runtime_key, { mode: 'always_on', state: permitted ? 'running' : 'sleeping', operation_id: null, check_at: null }, Date.now());
      receipt.restored++;
    } finally { collection.close(); }
  }
  return receipt;
}

async function main() {
  if (process.argv.length !== 3) throw new Error('usage: node tooling/execution-rollback.js PLATFORM_CONFIG');
  process.umask(0o077);
  const paths = require('dispatch-protocol/paths/platform-paths').loadPlatformPaths(process.argv[2]);
  const { acquireLock } = require('../host/controller/operations');
  const controller = acquireLock(paths, 'controller');
  let operation, access, execution;
  try {
    operation = acquireLock(paths, 'operation');
    const { AccessStore } = require('../core/accounts/src/store');
    const databaseRoot = path.join(paths.local, 'state/access-control');
    access = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') });
    execution = new (require('../core/agents/src/execution-store').ExecutionStore)(path.join(paths.local, 'state/execution/execution.sqlite3'));
    const journal = new (require('../host/controller/journal').DirectoryJournal)(paths);
    const host = new (require('../host/services/host').DirectoryHost)(paths, require('../host/services/installation').loadInstallation(paths));
    const result = await restore({ execution, access, journal, host, lockFd: operation, checkedDsp: record => {
      const dsp = require('../host/storage/storage').inspectDsp(paths, record.id);
      if (dsp.creationId !== record.creationId) throw new Error('runtime_identity_mismatch');
      return dsp;
    } });
    require('../core/installations/src/release-delivery-files').atomic(path.join(paths.local, 'config/execution.json'), { version: 1, enabled: false });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } finally {
    execution?.close(); access?.close();
    if (operation !== undefined) fs.closeSync(operation);
    fs.closeSync(controller);
  }
}
if (require.main === module) main().catch(error => { process.stderr.write((error.code || error.message) + '\n'); process.exitCode = 1; });
module.exports = { restore };
