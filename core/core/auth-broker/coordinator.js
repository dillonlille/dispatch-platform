'use strict';
const crypto = require('node:crypto');
const { DispatchError, boundedJson } = require('../../sdk/src/protocol');
const { service } = require('../../shared/contracts/src/connections');
const { validateRequest } = require('../../shared/contracts/src/auth-request');
const fail = code => { throw new DispatchError(code, { recoverable: true }); };
const same = (left, right) => ['dspId', 'pluginId', 'installationRevision', 'jobId'].every(key => left[key] === right[key]);

// Core retains worker/lease references only. Vault decryption, profile state and
// provider code stay in the admitted DSP-scoped authentication worker.
class AuthenticationCoordinator {
  constructor({ manager, workers, contextFor, authorizeRequest, authorizePlugin, relay, manualRetryFor = () => false, generationFor = () => '', clock = Date.now, idleMs = 5000 }) {
    if (!manager || !workers || [contextFor, authorizeRequest, authorizePlugin, relay].some(value => typeof value !== 'function')) throw new TypeError('auth_coordinator_dependencies_required');
    Object.assign(this, { manager, workers, contextFor, authorizeRequest, authorizePlugin, relay, manualRetryFor, generationFor, clock, idleMs });
    this.dsps = new Map(); this.sessions = new Map(); this.closing = false; this.polling = null;
    this.timer = setInterval(() => this.poll().catch(() => {}), 2000); this.timer.unref();
  }
  async ensure(dspId, retainGeneration = false, signal) {
    if (this.closing) fail('service_unavailable');
    if (signal?.aborted) fail('cancelled');
    let entry = this.dsps.get(dspId);
    if (entry?.closing) { await entry.closing; entry = null; }
    const generation = await this.generationFor(dspId);
    if (entry && entry.generation !== generation && !retainGeneration) {
      await entry.ready;
      if (entry.requests || [...this.sessions.values()].some(session => session.entry === entry)) fail('session_busy');
      const activity = await this.workers.request(entry.row, { action: 'activity' });
      if (!activity.ok || activity.busy || entry.requests) fail('session_busy');
      await this.closeEntry(dspId, entry);
      return this.ensure(dspId, retainGeneration, signal);
    }
    if (!entry) {
      const context = await this.contextFor(dspId);
      if (this.closing) fail('service_unavailable');
      if (this.dsps.has(dspId)) return this.ensure(dspId, retainGeneration, signal);
      entry = { context, generation, row: null, lease: null, requests: 0, waiters: 0, controller: new AbortController(), lastUsed: this.clock(), closing: null, ready: null };
      this.dsps.set(dspId, entry);
      entry.ready = this.manager.acquire(context, { connection: 'dsp-authentication', ttlMs: 300000, tabs: 6 }, { signal: entry.controller.signal })
        .then(lease => { entry.lease = lease; entry.row = this.manager.store.get(lease.leaseId); return entry; })
        .catch(error => { if (this.dsps.get(dspId) === entry) this.dsps.delete(dspId); throw error; });
    }
    entry.waiters++;
    let cancel;
    try {
      await (signal ? Promise.race([entry.ready, new Promise((_, reject) => {
        cancel = () => {
          if (entry.waiters === 1 && !entry.row) entry.controller.abort();
          reject(new DispatchError('cancelled'));
        };
        signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      })]) : entry.ready);
    } finally {
      entry.waiters--; if (cancel) signal.removeEventListener('abort', cancel);
      if (signal?.aborted && entry.waiters === 0 && !entry.row) entry.controller.abort();
    }
    if (this.closing || this.manager.store.get(entry.lease.leaseId)?.state !== 'active') fail('service_unavailable');
    return entry;
  }
  async request(dspId, value, { signal } = {}) {
    const request = validateRequest(boundedJson(value));
    if (!await this.authorizeRequest(dspId, request)) fail('permission_denied');
    if (signal?.aborted) fail('cancelled');
    // An installed adapter update must not destroy a pending Cortex email
    // verification. Metadata and its owner-entered code use that existing worker;
    // new logins wait until it is idle, then receive the new package generation.
    const retain = ['health', 'activity', 'list', 'status', 'profile-readiness', 'providers'].includes(request.action)
      || request.action === 'connections' && (request.input?.command === 'list'
        || request.input?.command === 'verify' && request.input.service === 'cortex');
    const entry = await this.ensure(dspId, retain, signal);
    if (entry.closing) fail('service_unavailable');
    entry.requests++; entry.lastUsed = this.clock();
    try {
      if (signal?.aborted || !await this.authorizeRequest(dspId, request)) fail('permission_denied');
      const response = await this.workers.request(entry.row, request, { signal });
      if (!await this.authorizeRequest(dspId, request) || signal?.aborted) {
        if (request.action === 'acquire-browser' && response?.session?.lease) await this.workers.request(entry.row,
          { action: 'release-browser', lease: response.session.lease }).catch(() => {});
        fail(signal?.aborted ? 'cancelled' : 'permission_denied');
      }
      return response;
    } finally { entry.requests--; entry.lastUsed = this.clock(); }
  }
  async connectionStatus(context, connection, options) {
    if (!await this.authorizePlugin(context, connection)) fail('permission_denied');
    const response = await this.request(context.dspId, { action: 'connections', input: { command: 'list' } }, options);
    const value = response.items?.find(item => item.service === connection);
    if (!response.ok || !value || !await this.authorizePlugin(context, connection)) fail('permission_denied');
    const states = { not_connected: 'unconfigured', connected: 'ready', checking: 'checking',
      verification_required: 'verification_required', credentials_rejected: 'rejected', not_verified: 'unavailable', temporarily_unavailable: 'unavailable' };
    if (!states[value.state]) fail('invalid_response');
    return { connection, configured: value.configured, state: states[value.state] };
  }
  async acquire(context, { connection, ttlMs }, options) {
    if (!await this.authorizePlugin(context, connection)) fail('permission_denied');
    const selected = service(connection);
    // Only Core's persisted collection job can authorize an interactive retry.
    // The plugin cannot request it through connections.acquire input.
    const manualRetry = connection === 'paycom' && await this.manualRetryFor(context) === true;
    const response = await this.request(context.dspId, { action: 'acquire-browser', profile: selected.profile,
      collector: context.pluginId, runId: context.jobId, ttlSeconds: Math.ceil(ttlMs / 1000),
      ...(manualRetry ? { manualRetry: true } : {}) }, options);
    if (!response.ok) fail(response.status);
    const entry = this.dsps.get(context.dspId);
    const leaseId = 'connection_' + crypto.randomBytes(16).toString('hex');
    let relay;
    try {
      if (!entry?.row || !await this.authorizePlugin(context, connection) || options?.signal?.aborted) fail('permission_denied');
      relay = await this.relay(context, entry.row, response.session.browser);
      this.sessions.set(leaseId, { context: Object.freeze({ ...context }), connection, lease: response.session.lease,
        entry, relay, ttlMs });
      return { leaseId, connection, ttlMs, protocol: 'cdp', endpoint: relay.endpoint, access: response.session.browser.access };
    } catch (error) {
      await relay?.close();
      if (entry?.row) await this.workers.request(entry.row, { action: 'release-browser', lease: response.session.lease });
      throw error;
    }
  }
  owned(context, id) {
    const session = this.sessions.get(id);
    if (!session || !same(context, session.context)) fail('lease_not_found');
    return session;
  }
  async renew(context, id) {
    const session = this.owned(context, id);
    if (!await this.authorizePlugin(context, session.connection)) { await this.release(context, id); fail('permission_denied'); }
    await this.manager.renew(session.entry.context, session.entry.lease.leaseId);
    const response = await this.workers.request(session.entry.row, { action: 'renew-browser', lease: session.lease, ttlSeconds: Math.ceil(session.ttlMs / 1000) });
    if (!response.ok || !await this.authorizePlugin(context, session.connection)) { await this.release(context, id); fail('lease_lost'); }
    return { renewed: true, ttlMs: session.ttlMs };
  }
  async release(context, id) {
    const session = this.owned(context, id);
    return session.releasing ||= (async () => {
      await session.relay.close();
      const response = await this.workers.request(session.entry.row, { action: 'release-browser', lease: session.lease });
      if (!response.ok && response.status !== 'lease_not_found') fail('browser_cleanup_failed');
      this.sessions.delete(id);
      return { released: true };
    })().catch(error => { session.releasing = null; throw error; });
  }
  async closeEntry(dspId, entry) {
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      entry.controller.abort();
      await entry.ready.catch(() => {});
      for (const [id, session] of this.sessions) if (session.entry === entry) {
        await session.relay.close(); this.sessions.delete(id);
      }
      if (entry.lease) await this.manager.release(entry.context, entry.lease.leaseId);
      if (this.dsps.get(dspId) === entry) this.dsps.delete(dspId);
    })().catch(error => { entry.closing = null; throw error; });
    return entry.closing;
  }
  poll() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      for (const [dspId, entry] of [...this.dsps]) {
        if (!entry.row || entry.requests || entry.waiters || entry.closing) continue;
        try {
          const response = await this.workers.request(entry.row, { action: 'activity' });
          if (!response.ok) throw new Error();
          if (entry.requests || entry.waiters) continue;
          const leased = [...this.sessions.values()].some(session => session.entry === entry);
          // Status polling can keep an otherwise idle worker warm forever.
          // Give queued DSPs its slot after the worker confirms it is idle;
          // in-progress sign-ins, verification and plugin leases stay intact.
          const waiting = this.manager.status().queued > 0;
          if (!response.busy && !leased && (waiting || this.clock() - entry.lastUsed >= this.idleMs)) {
            await this.closeEntry(dspId, entry);
            // Admit the queued DSP before considering another warm worker.
            await this.manager.pump();
          } else await this.manager.renew(entry.context, entry.lease.leaseId);
        } catch { await this.closeEntry(dspId, entry); }
      }
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  async revoke(dspId) {
    const entry = this.dsps.get(dspId);
    if (entry) await this.closeEntry(dspId, entry);
    await this.manager.revoke(dspId);
  }
  async revokePlugin(dspId, pluginId) {
    for (const [id, session] of this.sessions) if (session.context.dspId === dspId && session.context.pluginId === pluginId) {
      await this.release(session.context, id);
    }
  }
  handlers() {
    return {
      'connections.status': (context, { connection }, options) => this.connectionStatus(context, connection, options),
      'connections.acquire': (context, input, options) => this.acquire(context, input, options),
      'connections.renew': (context, { leaseId }) => this.renew(context, leaseId),
      'connections.release': (context, { leaseId }) => this.release(context, leaseId),
    };
  }
  async close() {
    this.closing = true; clearInterval(this.timer); await this.polling;
    await Promise.all([...this.dsps].map(([id, entry]) => this.closeEntry(id, entry)));
  }
}
module.exports = { AuthenticationCoordinator };
