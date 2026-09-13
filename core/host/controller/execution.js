'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { ExecutionStore } = require('../../core/agents/src/execution-store');
const { success, failure } = require('../../shared/contracts/src/result');
const { readStatus } = require('../../shared/published/status');
const { catalog, gatewayPlugin } = require('../../shared/plugin-sdk/catalog');
const { validateGatewayRequest } = require('../../shared/gateway/protocol');
const { privateJson } = require('../../core/installations/src/release-delivery-files');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { BACKEND, ACTIVE_STATES } = require('./access-authority');
const failed = code => failure(code, { recoverable: true });
const minimum = values => { const selected = values.filter(Number.isSafeInteger); return selected.length ? Math.min(...selected) : null; };

function settings(paths, supplied) {
  const value = supplied ?? privateJson(path.join(paths.local, 'config/execution.json'), process.geteuid(), true);
  if (!value) return { enabled: false };
  const allowed = ['version', 'enabled', 'runtimeKeys', 'maxActive', 'idleMs', 'pollMs'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('execution_configuration_invalid');
  const result = { maxActive: 2, idleMs: 30000, pollMs: 5000, runtimeKeys: null, ...value };
  if (!Number.isInteger(result.maxActive) || result.maxActive < 1 || result.maxActive > 32
      || !Number.isInteger(result.idleMs) || result.idleMs < 1000 || result.idleMs > 3600000
      || !Number.isInteger(result.pollMs) || result.pollMs < 100 || result.pollMs > 30000
      || result.runtimeKeys !== null && (!Array.isArray(result.runtimeKeys) || result.runtimeKeys.length > 4096)) throw new Error('execution_configuration_invalid');
  result.runtimeKeys?.forEach(validateDspId);
  return result;
}

class DirectoryExecution {
  constructor({ paths, accessStore, manager, hub, configuration, clock = Date.now, onError = () => {}, executionStore, publishedReader = null }) {
    this.publishedReader = publishedReader;
    this.paths = paths; this.access = accessStore; this.manager = manager; this.hub = hub; this.clock = clock; this.onError = onError;
    this.configuration = settings(paths, configuration);
    this.store = executionStore || (this.configuration.enabled ? new ExecutionStore(path.join(paths.local, 'state/execution/execution.sqlite3')) : null);
    this.locks = new Map(); this.timer = null; this.pending = null; this.closed = false;
  }
  eligible(id) { return this.configuration.enabled && (this.configuration.runtimeKeys === null || this.configuration.runtimeKeys.includes(id)); }
  context(id) {
    validateDspId(id);
    require('../releases/guard').assertAvailable(this.paths, id);
    const row = this.access.db.prepare('SELECT i.organization_id,i.status,i.revision,i.backend,o.status organization_status FROM installations i JOIN organizations o ON o.id=i.organization_id WHERE i.runtime_key=?').get(id);
    if (!row || row.backend !== BACKEND || !ACTIVE_STATES.includes(row.status)
        || !['pending_owner', 'setup_required', 'active'].includes(row.organization_status)
        || this.access.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(row.organization_id)
        || this.access.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id)) throw new Error('execution_not_permitted');
    return row;
  }
  directory(id) {
    const record = this.manager.journal.record(id);
    if (!record) throw new Error('runtime_identity_mismatch');
    return path.join(this.manager.checkedDsp(record).root, 'data/published');
  }
  cached(id, key) { return readStatus(this.directory(id), key); }
  async locked(id, action) {
    const before = this.locks.get(id) || Promise.resolve();
    const result = before.catch(() => {}).then(action);
    this.locks.set(id, result);
    try { return await result; } finally { if (this.locks.get(id) === result) this.locks.delete(id); }
  }
  async enroll(id) {
    if (!this.eligible(id)) return null;
    const context = this.context(id);
    return this.store.enroll(id, context.organization_id, this.clock());
  }
  changed(id) {
    if (!this.eligible(id)) return;
    const row = this.store.get(id);
    if (row) this.store.update(id, { check_at: this.clock(),
      ...(this.hub.connected(id) ? { state: 'starting', operation_id: null } : {}) }, this.clock());
    this.wake();
  }
  async checkpoint(id, command, scheduledAt = null) {
    const result = await this.hub.invoke(id, 'runtime.execution', { command, scheduledAt });
    if (!result?.ok || result.data?.version !== 1 || typeof result.data.busy !== 'boolean'
        || typeof result.data.drained !== 'boolean' || result.data.nextWakeAt !== null && !Number.isSafeInteger(result.data.nextWakeAt)) {
      throw new Error('execution_checkpoint_failed');
    }
    return result.data;
  }
  async start(id) {
    const context = this.context(id);
    let row = this.store.get(id) || await this.enroll(id);
    if (!this.hub.connected(id)) {
      if (row.state !== 'starting' && this.store.occupied() >= this.configuration.maxActive) throw new Error('execution_capacity_wait');
      const operation = row.state === 'starting' && row.operation_id ? row.operation_id : `wake_${crypto.randomBytes(16).toString('hex')}`;
      row = this.store.update(id, { state: 'starting', operation_id: operation }, this.clock());
      await this.manager.apply('start', operation, id);
    }
    const after = this.context(id);
    if (context.revision !== after.revision) throw new Error('execution_authority_changed');
    const checkpoint = await this.checkpoint(id, row.snapshot_ready ? 'resume' : 'adopt', row.next_wake_at !== null && row.next_wake_at <= this.clock() ? row.next_wake_at : this.clock());
    return this.store.update(id, { state: 'running', operation_id: null, snapshot_ready: 1, failure_code: null,
      next_wake_at: checkpoint.nextWakeAt, check_at: this.clock() + this.configuration.pollMs, last_activity: this.clock() }, this.clock());
  }
  async read(id, action, input) {
    const owner = gatewayPlugin(action, input);
    if (action.startsWith('workforce.')) {
      if (this.manager.pluginBackend && owner) return this.manager.pluginBackend.request(id, 'plugin.read', {
        pluginId: owner.id, request: { view: action.slice(10), query: action === 'workforce.employee' ? { code: input.code } : input.query || {} } });
      if (!owner?.published || !this.publishedReader) return failed('published_data_unavailable');
      const client = this.publishedReader({ pluginId: owner.id, directory: this.directory(id) });
      const method = action.slice('workforce.'.length);
      return client.workforce[method](method === 'employee' ? input.code : input.query);
    }
    const key = action === 'sync.status' ? `sync:${input.id}` : action === 'system.status' ? 'system'
      : action === 'collections.health' ? 'collections' : action === 'connections.manage' ? 'connections'
        : action === 'plugins.manage' ? 'plugins' : action === 'paycom.setup' ? 'paycom-readiness' : null;
    if (!key) return null;
    const snapshot = this.cached(id, key);
    if (!snapshot) return failed('published_status_unavailable');
    const result = snapshot.value;
    if (action === 'sync.status' && result.ok) {
      const pending = this.store.pending(id), last = this.store.latestJob(id);
      return success(result.status, { ...result.data,
        ...(pending ? { activity: 'queued', queuedRunCount: result.data.queuedRunCount + pending } : {}),
        queuedRequest: last ? { id: last.id, status: last.status,
          error: last.status === 'failed' ? JSON.parse(last.result_json)?.status : null } : null });
    }
    if (['system.status', 'collections.health'].includes(action) && result.ok) {
      const state = this.store.get(id)?.state || 'sleeping';
      const data = { ...result.data, execution: { state, observedAt: new Date(snapshot.observedAt).toISOString() } };
      if (action === 'collections.health' && state === 'sleeping') data.manager = { ...data.manager, running: false, pid: null, heartbeatAt: null };
      if (action === 'system.status' && state === 'sleeping') {
        data.components = structuredClone(data.components);
        for (const name of ['auth', 'collections']) {
          const component = data.components[name];
          if (component) { component.ready = false; component.status = 'sleeping'; }
        }
        if (data.components.collections?.data?.manager) Object.assign(data.components.collections.data.manager, { running: false, pid: null, heartbeatAt: null });
      }
      return success(state === 'sleeping' ? 'sleeping' : result.status, data);
    }
    return result;
  }
  async invoke(id, action, input) {
    if (this.manager.pluginBackend) {
      try {
        validateGatewayRequest({ protocolVersion: 1, runtimeKey: id, action, input });
        const context = this.context(id);
        if (action === 'connections.manage') {
          const result = await require('dispatch-runtime-kit/supervisor/src/connections').createRuntimeConnections(
            { paths: { auth: { socket: null } } }, (_socket, request) => this.manager.pluginBackend.request(id, 'auth.request', request))(input);
          this.context(id); return result;
        }
        if (action === 'plugins.manage' && input.command === 'status') {
          const fs = require('node:fs'), root = path.join(this.directory(id), '../collection-manager');
          const database = path.join(root, 'collection-manager.sqlite3');
          if (!fs.existsSync(database)) return success('found', { items: catalog().map(item => ({ id: item.id, version: item.version, state: 'uninstalled', revision: 0 })) });
          const store = new (require('dispatch-runtime-kit/collection-manager/src/store').CollectionStore)({ databaseRoot: root, database }, { readOnly: true });
          try { return success('found', { items: catalog().map(item => require('dispatch-runtime-kit/collection-manager/src/plugin-state').installation(store.db, item.id)) }); }
          finally { store.close(); }
        }
        const owner = action === 'plugins.invoke' ? catalog().find(item => item.id === input.pluginId) : gatewayPlugin(action, input);
        if (owner && action !== 'paycom.setup' && !require('../../core/accounts/src/plugins').available(this.access, context.organization_id, owner.id)) return failed('plugin_disabled');
        let response;
        if (action.startsWith('workforce.')) response = await this.read(id, action, input);
        else if (action === 'plugins.invoke' && input.action.startsWith('workforce.')) response = await this.read(id, input.action, input.input);
        else if (action === 'plugins.invoke') response = await this.manager.pluginBackend.request(id, 'plugin.invoke', { pluginId: input.pluginId, request: { action: input.action, input: input.input } });
        if (response) {
          this.context(id);
          if (owner && !require('../../core/accounts/src/plugins').available(this.access, context.organization_id, owner.id)) return failed('plugin_disabled');
          return response;
        }
      } catch { return failed('plugin_unavailable'); }
    }
    if (!this.eligible(id)) return this.hub.invoke(id, action, input);
    try {
      validateGatewayRequest({ protocolVersion: 1, runtimeKey: id, action, input });
      const context = this.context(id);
      const owner = action === 'plugins.invoke' ? catalog().find(item => item.id === input.pluginId) : gatewayPlugin(action, input);
      if (owner && !['plugins.manage', 'paycom.setup'].includes(action)
          && !require('../../core/accounts/src/plugins').available(this.access, context.organization_id, owner.id)) return failed('plugin_disabled');
      if (action === 'plugins.invoke' && ['workforce.day', 'workforce.employees', 'workforce.employee', 'sync.status', 'sync.run_now'].includes(input.action)
          && gatewayPlugin(input.action, input.input)?.id === input.pluginId) return this.invoke(id, input.action, input.input);
      const reading = action.startsWith('workforce.') || ['sync.status', 'system.status', 'collections.health'].includes(action)
        || action === 'connections.manage' && input.command === 'list'
        || action === 'plugins.manage' && input.command === 'status'
        || action === 'paycom.setup' && input.command === 'status' && input.step === 'readiness';
      const row = this.store.get(id);
      if (reading && row?.snapshot_ready) {
        let result = await this.read(id, action, input);
        // During the first publication, the already-running worker can still
        // serve its original saved data. This never starts a sleeping runtime.
        if (action.startsWith('workforce.') && result?.status === 'not_initialized' && this.hub.connected(id)) result = await this.hub.invoke(id, action, input);
        // Reading can await an injected plugin reader. Recheck organization and
        // plugin authorization before returning its data to the HTTP boundary.
        this.context(id);
        if (owner && !['plugins.manage', 'paycom.setup'].includes(action)
            && !require('../../core/accounts/src/plugins').available(this.access, context.organization_id, owner.id)) return failed('plugin_disabled');
        return result;
      }
      // Before adoption finishes, existing runtimes keep serving their reads.
      // Missing snapshots never cause a dashboard read to start a stopped DSP.
      if (reading) return this.hub.connected(id) ? this.hub.invoke(id, action, input) : failed('published_status_unavailable');
      if (action === 'sync.run_now') {
        await this.enroll(id);
        const job = this.store.enqueue(id, action, input, this.clock()); this.wake();
        return success('queued', { queued: true, request: { id: job.id, status: job.status } });
      }
      return await this.locked(id, async () => {
        await this.start(id); this.context(id);
        if (owner && !['plugins.manage', 'paycom.setup'].includes(action)
            && !require('../../core/accounts/src/plugins').available(this.access, context.organization_id, owner.id)) return failed('plugin_disabled');
        const result = await this.hub.invoke(id, action, input);
        // Publish the accepted mutation before a following settings read. A
        // checkpoint failure must not misreport an already-persisted save.
        try { await this.checkpoint(id, 'snapshot'); } catch (error) { this.onError(error); }
        this.store.update(id, { last_activity: this.clock(), check_at: this.clock() }, this.clock()); this.wake();
        return result;
      });
    } catch (error) { return failed(/^execution_|^published_|^idempotency_/.test(error.message) ? error.message : 'runtime_agent_unavailable'); }
  }
  async process(row) {
    const id = row.runtime_key;
    try {
      this.context(id);
      if (row.state === 'draining' && this.manager.journal.record(id)?.desiredState === 'stopped') {
        row = this.store.update(id, { state: 'sleeping' }, this.clock());
      }
      if (['adopting', 'starting'].includes(row.state)) row = await this.start(id);
      const job = this.store.job(id, this.clock());
      const due = row.next_wake_at !== null && row.next_wake_at <= this.clock();
      if ((job || due) && !this.hub.connected(id)) row = await this.start(id);
      if (job && this.hub.connected(id)) {
        this.context(id);
        const input = JSON.parse(job.input_json), owner = gatewayPlugin(job.action, input);
        const permitted = !owner || require('../../core/accounts/src/plugins').available(this.access, row.organization_id, owner.id);
        this.store.claim(job, this.clock());
        let result;
        try { result = permitted ? await this.hub.invoke(id, job.action, input) : failed('plugin_disabled'); }
        catch { result = failed('runtime_agent_unavailable'); }
        this.store.finish(job, result, this.clock(), ['runtime_agent_unavailable', 'runtime_gateway_unavailable'].includes(result.status));
        row = this.store.update(id, { last_activity: this.clock() }, this.clock());
      }
      if (!this.hub.connected(id)) {
        if (row.state !== 'sleeping') row = await this.start(id);
        else { this.store.update(id, { check_at: minimum([row.next_wake_at, this.store.nextJob(id)]) }, this.clock()); return; }
      }
      const checkpoint = await this.checkpoint(id, due ? 'tick' : 'snapshot', due ? row.next_wake_at : null);
      row = this.store.update(id, { state: 'running', snapshot_ready: 1, next_wake_at: checkpoint.nextWakeAt,
        ...(checkpoint.busy ? { last_activity: this.clock() } : {}), check_at: this.clock() + this.configuration.pollMs, failure_code: null }, this.clock());
      const queuedAt = this.store.nextJob(id);
      if (checkpoint.busy || queuedAt !== null && queuedAt <= this.clock() + this.configuration.idleMs || this.clock() - row.last_activity < this.configuration.idleMs
          || checkpoint.nextWakeAt !== null && checkpoint.nextWakeAt <= this.clock() + this.configuration.idleMs) return;
      // A pending clock tick must be acknowledged before drain; the next pass
      // observes it. A drain cannot bypass an asynchronous scheduler resolver.
      const final = await this.checkpoint(id, 'drain');
      if (!final.drained) { await this.checkpoint(id, 'resume'); return; }
      this.context(id);
      const operation = `sleep_${crypto.randomBytes(16).toString('hex')}`;
      this.store.update(id, { state: 'draining', operation_id: operation, next_wake_at: final.nextWakeAt }, this.clock());
      await this.manager.apply('stop', operation, id);
      this.store.update(id, { state: 'sleeping', operation_id: operation, check_at: minimum([final.nextWakeAt, this.store.nextJob(id)]), failure_code: null }, this.clock());
    } catch (error) {
      const code = /^execution_|^directory_/.test(error.message) ? error.message : 'execution_unavailable';
      this.store.update(id, { failure_code: code, check_at: this.clock() + (code === 'execution_not_permitted' ? 60000 : this.configuration.pollMs) }, this.clock());
      this.onError(Object.assign(new Error(code), { code }));
    }
  }
  runPending() {
    if (!this.configuration.enabled || this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const rows = this.access.db.prepare(`SELECT runtime_key FROM installations WHERE backend=? AND status IN ('waiting_for_owner','waiting_for_provider_auth','ready')`).all(BACKEND);
      for (const row of rows) if (this.eligible(row.runtime_key) && (!this.store.get(row.runtime_key) || this.store.get(row.runtime_key).mode === 'always_on')) {
        try { await this.enroll(row.runtime_key); } catch {}
      }
      const due = this.store.due(this.clock()).filter(row => !this.locks.has(row.runtime_key));
      const results = await require('../../shared/async/bounded-map').boundedMap(due, 2,
        row => this.locked(row.runtime_key, () => this.process(this.store.get(row.runtime_key))));
      for (const result of results) if (result.status === 'rejected') this.onError(result.reason);
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  wake(delay = 0) {
    if (!this.configuration.enabled || this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runPending().catch(this.onError).finally(() => this.wake(this.configuration.pollMs)), delay);
    this.timer.unref?.();
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    await this.pending;
    await Promise.allSettled([...this.locks.values()]);
    this.store?.close();
  }
}
module.exports = { DirectoryExecution, settings };
