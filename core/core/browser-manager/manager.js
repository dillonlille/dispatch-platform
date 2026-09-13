'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DispatchError, identifier, key } = require('../../sdk/src/protocol');

function contextOf(row) {
  return Object.freeze({ dspId: row.dsp_id, pluginId: row.plugin_id, installationRevision: row.revision, jobId: row.job_id });
}
function matches(row, context) {
  return row && row.dsp_id === context.dspId && row.plugin_id === context.pluginId
    && row.revision === context.installationRevision && row.job_id === context.jobId;
}
function error(code) { return new DispatchError(code, { recoverable: true }); }

class BrowserManager {
  constructor({ store, workers, authorize, clock = Date.now, monotonicClock = () => performance.now(), limits = {} }) {
    if (!store || typeof workers?.start !== 'function' || typeof workers?.close !== 'function'
        || typeof authorize !== 'function') throw new TypeError('browser_manager_dependencies_required');
    this.limits = { sessions: 2, tabs: 6, perDsp: 1, queue: 128, queueMs: 30000, startMs: 300000, ...limits };
    if (Object.keys(this.limits).sort().join(',') !== 'perDsp,queue,queueMs,sessions,startMs,tabs'
        || Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)
        || this.limits.sessions > 64 || this.limits.tabs > 256 || this.limits.queue > 1024
        || this.limits.queueMs > 300000 || this.limits.startMs > 300000) throw new TypeError('browser_limits_invalid');
    this.store = store; this.workers = workers; this.authorize = authorize; this.clock = clock; this.monotonicClock = monotonicClock;
    this.deadlines = new Map();
    this.pending = new Map(); this.handles = new Map(); this.launches = new Map(); this.closing = new Map();
    this.pumping = null; this.ready = false; this.stopped = false; this.timer = null;
  }
  async start() {
    if (this.ready || this.stopped) throw error('service_unavailable');
    // Only an exclusively supervised owner may open this service. After restart
    // no in-memory browser capability survives: reap persisted worker identities
    // before new admission. A failed close continues consuming capacity.
    for (const row of this.store.rows()) await this.finish(row.id, error('lease_lost'));
    this.ready = true;
    this.timer = setInterval(() => { this.pump().catch(() => {}); }, 1000); this.timer.unref();
  }
  async acquire(context, { connection, ttlMs, tabs = 1 }, { signal } = {}) {
    identifier(connection); identifier(context.pluginId); key(context.jobId);
    if (!/^dsp_[a-f0-9]{32}$/.test(context.dspId) || !Number.isSafeInteger(context.installationRevision)
        || context.installationRevision < 1 || !Number.isInteger(ttlMs) || ttlMs < 30000 || ttlMs > 300000
        || !Number.isInteger(tabs) || tabs < 1 || tabs > this.limits.tabs) throw error('invalid_request');
    if (!this.ready || this.stopped) throw error('service_unavailable');
    if (signal?.aborted) throw error('cancelled');
    if (!await this.authorize(context, connection)) throw error('permission_denied');
    if (signal?.aborted || this.stopped) throw error('cancelled');
    const id = `browser_${crypto.randomBytes(24).toString('hex')}`;
    const now = this.clock();
    const conflict = this.store.enqueue(id, context, { connection, ttlMs, tabs }, now, now + this.limits.queueMs, this.limits.queue);
    if (conflict) throw error(conflict);
    this.deadlines.set(id, this.monotonicClock() + this.limits.queueMs);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const cancel = () => { this.finish(id, error('cancelled')).catch(() => {}); };
    this.pending.set(id, { resolve, reject, detach: () => signal?.removeEventListener('abort', cancel) });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    this.pump().catch(() => { this.finish(id, error('service_unavailable')).catch(() => {}); });
    return promise;
  }
  async pump() {
    if (this.stopped || !this.ready) return;
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      for (const row of this.store.rows()) {
        if (this.expired(row) || row.state === 'closing') {
          // Cleanup may be slow; other DSPs can use unrelated remaining slots.
          this.finish(row.id, error(row.state === 'queued' ? 'queue_timeout' : 'lease_lost')).catch(() => {});
        }
      }
      for (const row of this.store.rows().filter(item => item.state === 'queued')) {
        if (this.stopped) break;
        if (!await this.authorize(contextOf(row), row.connection)) { await this.finish(row.id, error('permission_denied')); continue; }
        if (!this.store.claim(row.id, this.limits, this.clock())) continue;
        this.deadlines.set(row.id, this.monotonicClock() + this.limits.startMs);
        const controller = new AbortController();
        const launch = { controller, promise: null };
        // Install the record before dispatching asynchronous worker startup.
        this.launches.set(row.id, launch);
        launch.promise = Promise.resolve().then(() => this.launch(row.id, controller.signal));
      }
      this.store.prune(this.clock());
    })().finally(() => { this.pumping = null; });
    return this.pumping;
  }
  async launch(id, signal) {
    try {
      const row = this.store.get(id);
      const handle = await this.workers.start(row, { signal });
      if (!['cdp', 'worker'].includes(handle?.protocol) || typeof handle.endpoint !== 'string' || typeof handle.access !== 'string') throw error('invalid_response');
      this.handles.set(id, handle);
      if (signal.aborted || this.stopped || this.store.get(id)?.state !== 'starting'
          || !await this.authorize(contextOf(row), row.connection)) throw error('permission_denied');
      this.store.state(id, 'active', this.clock() + row.ttl_ms);
      this.deadlines.set(id, this.monotonicClock() + row.ttl_ms);
      const pending = this.pending.get(id);
      pending?.detach(); this.pending.delete(id);
      pending?.resolve({ leaseId: id, connection: row.connection, ttlMs: row.ttl_ms,
        protocol: handle.protocol, endpoint: handle.endpoint, access: handle.access });
    } catch (cause) {
      this.launches.delete(id);
      this.finish(id, cause instanceof DispatchError ? cause : error('authentication_failed')).catch(() => {});
    } finally { this.launches.delete(id); }
  }
  async finish(id, reason = null) {
    if (this.closing.has(id)) return this.closing.get(id);
    const row = this.store.get(id);
    if (!row || row.state === 'closed') return { released: true };
    const pending = this.pending.get(id);
    if (pending) { pending.detach(); pending.reject(reason || error('cancelled')); this.pending.delete(id); }
    this.store.state(id, 'closing');
    const launch = this.launches.get(id); launch?.controller.abort(reason);
    const closing = (async () => {
      // Host close is idempotent and keyed by the persisted lease id, so it can
      // reap a process even if startup never returned a browser endpoint.
      if (row.state !== 'queued') {
        // Cancel startup before waiting, then close again after it settles. A
        // late startup result must never outlive an already-reassigned slot.
        if (launch) {
          await this.workers.close(row);
          await launch.promise;
        }
        const stopped = await this.workers.close(this.store.get(id));
        if (stopped !== true) throw error('browser_cleanup_failed');
      }
      this.handles.delete(id); this.deadlines.delete(id); this.store.state(id, 'closed');
      return { released: true };
    })().catch(() => { throw error('browser_cleanup_failed'); }).finally(() => { this.closing.delete(id); });
    this.closing.set(id, closing);
    return closing;
  }
  owned(context, id) {
    key(id); const row = this.store.get(id);
    if (!matches(row, context)) throw error('lease_not_found');
    return row;
  }
  expired(row) {
    const deadline = this.deadlines.get(row.id);
    return deadline === undefined ? row.expires_at <= this.clock() : deadline <= this.monotonicClock();
  }
  async renew(context, id) {
    const row = this.owned(context, id);
    if (this.stopped || row.state !== 'active' || this.expired(row)) {
      await this.finish(id, error('lease_lost')); throw error('lease_lost');
    }
    if (!await this.authorize(context, row.connection)) { await this.finish(id, error('permission_denied')); throw error('permission_denied'); }
    if (this.workers.renew) {
      try { await this.workers.renew(row); }
      catch { await this.finish(id, error('lease_lost')); throw error('lease_lost'); }
    }
    if (this.store.get(id)?.state !== 'active') throw error('lease_lost');
    if (this.expired(row) || !await this.authorize(context, row.connection)) {
      await this.finish(id, error('lease_lost')); throw error('lease_lost');
    }
    this.store.renew(id, this.clock()); this.deadlines.set(id, this.monotonicClock() + row.ttl_ms);
    return { renewed: true, ttlMs: row.ttl_ms };
  }
  async release(context, id) { this.owned(context, id); return this.finish(id); }
  async revoke(dspId, pluginId = null) {
    for (const row of this.store.rows().filter(item => item.dsp_id === dspId && (!pluginId || item.plugin_id === pluginId))) {
      await this.finish(row.id, error('permission_denied'));
    }
  }
  status() {
    const rows = this.store.rows();
    return { sessions: rows.filter(row => ['starting', 'active', 'closing'].includes(row.state)).length,
      queued: rows.filter(row => row.state === 'queued').length, closing: rows.filter(row => row.state === 'closing').length };
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    if (this.pumping) await this.pumping;
    const results = await Promise.allSettled(this.store.rows().map(row => this.finish(row.id, error('service_unavailable'))));
    await Promise.allSettled([...this.launches.values()].map(item => item.promise));
    if (results.some(item => item.status === 'rejected')) throw error('browser_cleanup_failed');
  }
}
module.exports = { BrowserManager, contextOf };
