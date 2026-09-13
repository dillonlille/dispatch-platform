'use strict';

const path = require('node:path');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const control = require('../../collection-manager/src/execution-control');
const { nextWake } = require('../../collection-manager/src/next-wake');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { catalog, pluginEntry, ROOT } = require('dispatch-protocol/plugin-sdk/catalog');
const { saveStatus } = require('dispatch-protocol/published/status');
const { success, failure } = require('dispatch-protocol/contracts/src/result');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function nextObservation(values, now) {
  const dates = [...(values.connections?.data?.items || []).map(item => item.retryAt), values['paycom-readiness']?.data?.retryAt]
    .filter(Boolean).map(Date.parse).filter(value => Number.isSafeInteger(value) && value > now);
  return dates.length ? Math.min(...dates) : null;
}

function createExecution({ configuration, client, plugins, activeRequests = () => 0, authRequest = request }) {
  let pending = null, lastSystem = null, systemAt = 0;
  const publications = new Map();
  const directory = path.join(configuration.paths.dataRoot, 'published');
  async function execute(input) {
    const store = new CollectionStore(configuration.paths.collection);
    try {
      const now = Date.now();
      if (input.command !== 'snapshot') control.command(store, input.command, input.scheduledAt);
      if (input.command === 'restore') return success('restored', {});
      // The manager must observe drain after its last asynchronous scheduler tick.
      if (input.command === 'drain') {
        const deadline = now + 3000;
        while (Date.now() < deadline) {
          const state = control.read(store.db);
          if (state?.draining && state.acknowledged === state.generation) break;
          await pause(25);
        }
      }
      const activity = await authRequest(configuration.paths.auth.socket, { action: 'activity' });
      if (!activity?.ok || typeof activity.busy !== 'boolean') return failure('execution_state_unavailable', { recoverable: true });
      const connections = await client.connectionsManage({ command: 'list' });
      if (!connections.ok) return failure('execution_state_unavailable', { recoverable: true });
      if (!lastSystem || now - systemAt >= 60000 || input.command === 'adopt' || input.command === 'drain') {
        lastSystem = await client.system.status(); systemAt = now;
      }
      const values = { system: lastSystem, connections, plugins: await plugins.manage({ command: 'status' }) };
      values.collections = await client.collections.health();
      const enabled = catalog().filter(definition => plugins.enabled(definition.id));
      for (const definition of enabled) {
        for (const id of definition.syncs) values[`sync:${id}`] = await client.sync.status(id);
        const publisher = process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1'
          ? () => require('dispatch-sdk/runtime').createFrameworkClient().request('plugin.publish', { pluginId: definition.id, request: {} })
          : definition.runtime && require(pluginEntry(ROOT, definition, 'runtime')).publish;
        if (publisher) {
          const source = store.sources().find(item => definition.collectors.includes(item.collector));
          if (source?.config?.timezone && !publications.has(definition.id)) {
            const task = { pending: true, error: null };
            publications.set(definition.id, task);
            task.promise = Promise.resolve().then(() => publisher({ paths: configuration.paths, directory, timezone: source.config.timezone }))
              .catch(error => { task.error = error; }).finally(() => { task.pending = false; });
            // Unchanged pointers finish immediately. Full publication runs in a
            // temporary worker; its pending state prevents idle shutdown.
            await Promise.race([task.promise, pause(25)]);
          }
          const task = publications.get(definition.id);
          if (task && !task.pending) {
            publications.delete(definition.id);
            if (task.error) throw task.error;
          }
        }
      }
      if (enabled.some(definition => definition.id === 'paycom')) {
        const readiness = await authRequest(configuration.paths.auth.socket, { action: 'profile-readiness', profile: 'paycom-main' });
        if (readiness?.ok && readiness.readiness) values['paycom-readiness'] = success('succeeded', readiness.readiness);
      }
      const state = control.read(store.db);
      const running = store.db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n;
      const queuedNow = store.db.prepare("SELECT count(*) n FROM runs WHERE status='queued' AND run_after<=?").get(Date.now()).n;
      const deadlines = [await nextWake(store, Date.now()), nextObservation(values, now)].filter(Number.isSafeInteger);
      const next = deadlines.length ? Math.min(...deadlines) : null;
      const unsettledClock = state && state.requestedAt !== null && (state.completedAt === null || state.requestedAt > state.completedAt);
      // Disabled plugins can still have a publication that must finish safely.
      for (const [id, task] of publications) if (!task.pending && !enabled.some(item => item.id === id)) publications.delete(id);
      const busy = Boolean(publications.size || activity.busy || plugins.busy() || activeRequests() || running || queuedNow || unsettledClock
        || enabled.some(definition => !definition.published));
      const execution = { version: 1, busy, nextWakeAt: next,
        drained: Boolean(state?.draining && state.acknowledged === state.generation && !busy), observedAt: Date.now() };
      values.execution = execution;
      saveStatus(directory, values, execution.observedAt);
      return success('found', execution);
    } finally { store.close(); }
  }
  return input => {
    if (pending) return Promise.resolve(failure('execution_busy', { recoverable: true }));
    pending = execute(input).finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createExecution, nextObservation };
