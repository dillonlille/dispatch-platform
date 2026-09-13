'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserStore } = require('../browser-manager/store');
const { BrowserManager } = require('../browser-manager/manager');
const { AuthenticationCoordinator } = require('../auth-broker/coordinator');
const { ScopedWorkerHost } = require('../../host/services/scoped-worker');
const { AuthenticationWorkerHost } = require('../../host/services/authentication-worker');
const { browserRelay } = require('../../host/plugins/browser-relay');
const { installedPackage, installationReceipt } = require('../../host/plugins/install');
const { privateDirectory } = require('../../host/controller/operations');
const { privateJson, atomic } = require('../installations/src/release-delivery-files');
const { createPluginService } = require('./sdk-service');
const { createAccessPluginAuthority } = require('./access-authority');
const { createRuntimeServices } = require('./runtime-services');
const { hasGrant } = require('./connection-grants');
const { DispatchError } = require('../../sdk/src/protocol');
const fail = code => { throw new DispatchError(code, { recoverable: true }); };
const { settingsStore } = require('./settings-store');
const { initializeSettings, applySettingsPolicy } = require('./settings-policy');

// The independent Core backend holds policy, admission and process references.
// Every provider entrypoint runs in a selected DSP's disposable namespace.
async function openPluginBackend({ paths, installation, store, dspRoot, permitted, timezoneFor,
  wake, networkPolicy, assistance, sourceRoot = paths.live, runtimeSourceFor = id => require('../../host/releases/runtime').runtimeSource(paths,id), workerHost, authenticationHost, limits = {} }) {
  const stateRoot = privateDirectory(path.join(paths.local, 'state/plugin-backend'));
  const jobsRoot = privateDirectory(path.join(stateRoot, 'jobs'));
  const namespaceRoot = privateDirectory(path.join(paths.local, 'run/plugin-backend-namespaces'));
  const jobs = new Map(), active = new Map(), queue = [], cleanup = new Map();
  let closing = false;
  const workers = workerHost || new ScopedWorkerHost({ sourceRoot, sourceRootFor: runtimeSourceFor, nodeRoot: installation.nodeRoot, namespaceRoot });
  function rowFor(dspId, pluginId) {
    return store.db.prepare(`SELECT p.* FROM dsp_plugins p JOIN installations i ON i.organization_id=p.organization_id
      WHERE i.runtime_key=? AND p.plugin_id=?`).get(dspId, pluginId);
  }
  function selected(dspId, pluginId) {
    if (!permitted(dspId)) fail('permission_denied');
    const row = rowFor(dspId, pluginId);
    if (!row || row.desired_state !== 'enabled' || row.applied_state !== 'enabled' || row.revision !== row.applied_revision) fail('plugin_disabled');
    const value = installedPackage({ dspRoot: dspRoot(dspId), pluginId, revision: row.revision });
    if (value.manifest.plugin.version !== row.version) fail('plugin_revision_conflict');
    return value;
  }
  function packages(dspId) {
    return store.db.prepare('SELECT p.plugin_id FROM dsp_plugins p JOIN installations i ON i.organization_id=p.organization_id WHERE i.runtime_key=?').all(dspId).flatMap(row => {
      try { const value = selected(dspId, row.plugin_id); return [{ id: row.plugin_id, directory: value.directory, digest: value.receipt.digest }]; }
      catch { return []; }
    });
  }
  const authWorkers = authenticationHost || new AuthenticationWorkerHost({ sourceRoot, sourceRootFor: runtimeSourceFor, ...installation, namespaceRoot,
    dspRoot, packages, permitted, networkPolicy, assistance });
  const browsers = new BrowserStore(path.join(stateRoot, 'browsers.sqlite3'));
  let manager, auth;
  function manifestFor(context) { return jobs.get(context.jobId)?.manifest || null; }
  const ordinary = createAccessPluginAuthority({ store, manifestFor,
    connectionGrant: (context, service) => hasGrant(dspRoot(context.dspId), context, service) });
  const authorize = (context, request) => {
    const job = jobs.get(context.jobId);
    if (!job || job.cancelled || closing || !permitted(context.dspId)) return false;
    if (job.kind !== 'initialize') return ordinary(context, request);
    const row = rowFor(context.dspId, context.pluginId);
    return ['capabilities.get', 'settings.get', 'progress.report', 'log.write'].includes(request.operation)
      && row?.revision === context.installationRevision && row.version === job.manifest.version && row.desired_state === 'enabled';
  };
  const authorizePlugin = (context, connection) => authorize(context, { operation: 'connections.acquire', input: { connection } });
  function authAllowed(dspId, request) {
    if (!permitted(dspId)) return false;
    const provider = request.input?.service || (request.profile === 'paycom-main' || request.action === 'enroll-paycom' ? 'paycom' : null);
    if (!provider || provider === 'cortex') return true;
    try { return packages(dspId).some(item => item.id === provider); } catch { return false; }
  }
  manager = new BrowserManager({ store: browsers, workers: { start: (...args) => authWorkers.startLease(...args), close: row => authWorkers.closeLease(row) },
    authorize: context => permitted(context.dspId), limits: { sessions: 2, tabs: 12, perDsp: 1, ...limits.browser } });
  try {
    await manager.start();
    // A Core crash invalidates every SDK binding. Reap each durable identity
    // before accepting new work, even if its result was never acknowledged.
    for (const name of fs.readdirSync(jobsRoot)) {
      if (!/^job_[a-f0-9]{32}\.json$/.test(name)) fail('plugin_worker_boundary');
      const record = privateJson(path.join(jobsRoot, name), process.geteuid());
      if (Object.keys(record).sort().join(',') !== 'dspId,jobId,schemaVersion' || record.schemaVersion !== 1 || record.jobId + '.json' !== name) fail('plugin_worker_boundary');
      const root = dspRoot(record.dspId);
      await workers.stop(record.jobId);
      fs.rmSync(path.join(root, 'run/plugin-workers', record.jobId), { recursive: true, force: true });
      fs.unlinkSync(path.join(jobsRoot, name));
    }
    auth = new AuthenticationCoordinator({ manager, workers: authWorkers,
      generationFor: dspId => JSON.stringify(packages(dspId).map(item => [item.id, item.digest])),
      contextFor: dspId => ({ dspId, pluginId: 'core-auth', installationRevision: 1, jobId: 'auth_' + crypto.randomBytes(16).toString('hex') }),
      authorizeRequest: authAllowed, authorizePlugin,
      manualRetryFor: context => require('./manual-auth-retry').manualAuthRetry(dspRoot(context.dspId), context, jobs.get(context.jobId)),
      relay: (context, row, browser) => {
        const job = jobs.get(context.jobId);
        if (!job || job.cancelled) fail('permission_denied');
        return browserRelay({ dspId: context.dspId, authRunRoot: authWorkers.selected(row).runRoot,
          runRoot: job.runRoot, browser });
      } });
  } catch (error) { await manager?.close(); browsers.close(); throw error; }
  const handlers = createRuntimeServices({ dspRoot, manifestFor, timezoneFor, wake,
    invoke: (context, action, input, options) => nested(context, 'invoke', { action, input }, options),
    published: (context, view, query, options) => nested(context, 'read', { view, query }, options) });
  const sdk = createPluginService({ authorize, handlers: { ...handlers, ...auth.handlers(),
    'settings.get': context => {
      const snapshot = jobs.get(context.jobId)?.settings;
      if (!snapshot) fail('capability_unavailable');
      return snapshot;
    },
  } });
  const maximum = limits.workers || 8, perDsp = limits.perDsp || 2;
  let reaping = false, nextSettingsCheck = 0;
  const cleanupTimer = setInterval(async () => {
    if (reaping) return;
    reaping = true;
    try {
      for (const [jobId, release] of cleanup) {
        try { await workers.reap(jobId); cleanup.delete(jobId); release(); } catch { /* Keep capacity reserved and retry. */ }
      }
      if (Date.now() >= nextSettingsCheck) { nextSettingsCheck = Date.now() + 15000;
      for (const row of store.db.prepare(`SELECT i.runtime_key,p.plugin_id FROM dsp_plugins p
        JOIN installations i ON i.organization_id=p.organization_id WHERE p.desired_state='enabled'
        AND p.applied_state='enabled' AND p.revision=p.applied_revision AND i.status='ready'`).all()) {
        try { if (!settingsStore(dspRoot(row.runtime_key),row.plugin_id).pending()) continue;
          const manifest = selected(row.runtime_key,row.plugin_id).manifest.plugin;
          if (!require('../../host/releases/guard').updating(paths, row.runtime_key)) applySettingsPolicy(dspRoot(row.runtime_key),manifest); } catch { /* Pending policy is retried after lifecycle/storage recovery. */ }
      }
      }
    } finally { reaping = false; }
  }, 1000);
  cleanupTimer.unref();
  function pump() {
    for (let index = 0; index < queue.length && active.size < maximum;) {
      const item = queue[index];
      if (closing || item.signal?.aborted || Date.now() >= item.deadline) {
        queue.splice(index, 1); item.reject(new DispatchError(closing ? 'service_unavailable' : 'cancelled')); continue;
      }
      if ([...active.values()].filter(job => job.dspId === item.dspId).length >= perDsp
          || item.writer && !item.nested && [...active.values()].some(job => job.dspId === item.dspId && job.pluginId === item.pluginId && job.writer)) { index++; continue; }
      queue.splice(index, 1); const token = Symbol(); active.set(token, item); item.resolve(token);
    }
  }
  async function admission(dspId, pluginId, writer, signal, timeoutMs, nested = false) {
    if (closing || queue.length >= 128) fail('plugin_worker_capacity');
    // A parent never waits while holding the last worker slot. Nested calls
    // either use spare bounded capacity immediately or return a retryable error.
    if (nested && (active.size >= maximum || [...active.values()].filter(job => job.dspId === dspId).length >= perDsp)) fail('plugin_worker_capacity');
    let token;
    const timer = setInterval(pump, 1000); timer.unref();
    const cancel = () => pump(); signal?.addEventListener('abort', cancel, { once: true });
    try { token = await new Promise((resolve, reject) => { const item = { dspId, pluginId, writer, nested, signal, deadline: Date.now() + timeoutMs, resolve, reject };
      if (nested) queue.unshift(item); else queue.push(item); pump(); }); }
    finally { clearInterval(timer); signal?.removeEventListener('abort', cancel); }
    return () => { active.delete(token); pump(); };
  }
  function nested(context, kind, input, options) {
    const parent = jobs.get(context.jobId);
    if (!parent || parent.nested) fail('nested_action_limit');
    return execute(context.dspId, context.pluginId, kind, input, { ...options, nested: true });
  }
  async function execute(dspId, pluginId, kind, input, { signal, initialize, timeoutMs = 300000, nested = false } = {}) {
    if (!['initialize', 'invoke', 'collect', 'publish', 'read', 'inspect', 'evidence'].includes(kind)) fail('invalid_request');
    const chosen = initialize || selected(dspId, pluginId);
    const manifest = chosen.manifest.plugin;
    const revision = initialize?.revision || chosen.receipt.revision;
    if (manifest.id !== pluginId) fail('permission_denied');
    if (kind === 'invoke' && !manifest.actions.some(item => item.id === input.action)) fail('permission_denied');
    if (kind === 'collect' && !manifest.collectors.includes(input.source?.collector)) fail('permission_denied');
    if (kind === 'collect') {
      const remaining = Date.parse(input.deadline) - Date.now();
      if (!Number.isSafeInteger(remaining) || remaining <= 0) fail('collector_timeout');
      timeoutMs = Math.min(3600000, remaining);
      // The six-page auth namespace retains one authenticated handoff page.
      // Grant collection concurrency from the remaining five page slots.
      const requested = input.source?.config?.maxConcurrency;
      if (Number.isInteger(requested) && requested >= 1 && requested <= 6) input = {
        ...input, source: { ...input.source, config: { ...input.source.config, maxConcurrency: Math.min(requested, 5) } },
      };
    }
    if (kind === 'evidence') {
      const { exact } = require('../../sdk/src/protocol');
      exact(input, ['batchId', 'preparationRunId', 'definitionDigest']);
      const databaseRoot = path.join(dspRoot(dspId), 'data/collection-manager');
      const collections = new (require('dispatch-runtime-kit/collection-manager/src/store').CollectionStore)(
        { databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3') }, { readOnly: true, plugins: [manifest] });
      try {
        const batch = collections.batch(input.batchId);
        const runs = [input.preparationRunId, ...batch.runs.map(item => item.run.id)].map(id => collections.run(id));
        if (runs.some(run => !manifest.collectors.includes(run.collector))) fail('permission_denied');
        input = { ...input, batch, runs };
      } finally { collections.close(); }
    }
    const revalidate = () => {
      if (!permitted(dspId)) fail('permission_denied');
      if (initialize) {
        const row = rowFor(dspId, pluginId);
        if (row?.revision !== revision || row.version !== manifest.version || row.desired_state !== 'enabled') fail('permission_denied');
      } else {
        const current = selected(dspId, pluginId);
        if (current.receipt.revision !== revision || current.receipt.digest !== chosen.receipt.digest) fail('plugin_revision_conflict');
      }
    };
    revalidate();
    const deadline = Date.now() + timeoutMs;
    const release = await admission(dspId, pluginId, kind !== 'read', signal, timeoutMs, nested);
    let ownedJobId;
    try {
      revalidate();
      timeoutMs = Math.max(1, deadline - Date.now());
      if (kind === 'initialize') initializeSettings(dspRoot(dspId), manifest);
      const settings = manifest.settings ? settingsStore(dspRoot(dspId), pluginId).read(manifest.settings) : null;
      const result = await workers.run({ dspRoot: dspRoot(dspId), dspId, pluginId, version: manifest.version,
        digest: chosen.digest || chosen.receipt.digest, signal, timeoutMs,
        task: { kind, action: kind === 'invoke' ? input.action : null, input: kind === 'invoke' ? input.input : input, timezone: timezoneFor(dspId) },
        transport: ({ jobId, runRoot }) => {
          ownedJobId = jobId;
          const context = Object.freeze({ dspId, pluginId, installationRevision: revision, jobId });
          atomic(path.join(jobsRoot, jobId + '.json'), { schemaVersion: 1, dspId, jobId });
          jobs.set(jobId, { context, manifest, settings, runRoot, kind, nested, cancelled: false,
            collectionRunId: kind === 'collect' ? input.runId : null });
          return sdk.bind(context);
        },
        onClose: async ({ jobId }) => {
          for (const [id, session] of auth.sessions) if (session.context.jobId === jobId) await auth.release(session.context, id);
          jobs.delete(jobId); fs.unlinkSync(path.join(jobsRoot, jobId + '.json'));
        } });
      revalidate();
      return result;
    } finally {
      if (ownedJobId && jobs.has(ownedJobId)) cleanup.set(ownedJobId, release);
      else release();
    }
  }
  async function revoke(dspId, pluginId) {
    for (const job of jobs.values()) if (job.context.dspId === dspId && (!pluginId || job.context.pluginId === pluginId)) job.cancelled = true;
    await workers.revoke(dspId, pluginId);
    if (pluginId) await auth.revokePlugin(dspId, pluginId); else await auth.revoke(dspId);
  }
  return { execute, selected, packages, auth, workers, manager, jobs, revoke,
    async settingsRequest(dspId, pluginId, request, options) {
      const chosen = selected(dspId,pluginId), manifest = chosen.manifest.plugin;
      if (!manifest.settings) fail('capability_unavailable');
      const storage = settingsStore(dspRoot(dspId),pluginId);
      if (request.action === 'update') {
        storage.update(manifest.settings,request.input,request.actor);
        applySettingsPolicy(dspRoot(dspId),manifest); wake(dspId);
      }
      const current = request.action === 'history' ? storage.history(manifest.settings,request.input) : storage.read(manifest.settings);
      let choices = {};
      if (request.action === 'options' && manifest.settings.optionsView) {
        choices = await execute(dspId,pluginId,'read',{view:manifest.settings.optionsView,query:{}},options);
      }
      if (selected(dspId,pluginId).receipt.revision !== chosen.receipt.revision) fail('plugin_revision_conflict');
      return request.action === 'options' ? choices : current;
    },
    canStart(dspId) {
      return !store.db.prepare(`SELECT 1 FROM dsp_plugins p JOIN installations i ON i.organization_id=p.organization_id
        WHERE i.runtime_key=? AND p.revision<>p.applied_revision`).get(dspId);
    },
    async authRequest(dspId, request, options) {
      if (!authAllowed(dspId, request)) fail('permission_denied');
      if (request.action === 'activity' && !auth.dsps.has(dspId)) return { ok: true, status: 'idle', busy: false };
      // Only SDK jobs may obtain a browser capability. Framework operations
      // administer connections and submit work, never raw browser sessions.
      if (['acquire-browser', 'renew-browser', 'release-browser'].includes(request.action)) fail('permission_denied');
      return auth.request(dspId, request, options);
    },
    async close() {
      closing = true; pump();
      await Promise.all([...new Set([...jobs.values()].map(job => job.context.dspId))].map(id => revoke(id)));
      const deadline = Date.now() + 35000;
      while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (active.size) fail('plugin_worker_stop_failed');
      clearInterval(cleanupTimer);
      await auth.close(); await manager.close(); browsers.close();
    } };
}
module.exports = { openPluginBackend };
