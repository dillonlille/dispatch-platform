'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { encodeFrame, attachFrameReader } = require('dispatch-protocol/agent/framing');
const { validateCapacityRequest, validateCapacityResponse } = require('dispatch-protocol/agent/capacity');
const { runCollector } = require('dispatch-runtime-kit/collection-manager/src/runner');

function queryCapacity(socketPath, input) {
  return new Promise((resolve, reject) => {
    const request = validateCapacityRequest({ type: 'capacity_request', requestId: crypto.randomBytes(16).toString('hex'), ...input });
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(Error('capacity_unavailable')); else resolve(response);
    };
    const timer = setTimeout(() => finish(true), 3000);
    socket.on('connect', () => socket.write(encodeFrame(request)));
    socket.on('error', () => finish(true));
    socket.on('close', () => finish(true));
    attachFrameReader(socket, { maxFrameBytes: 4096, onError: () => finish(true), onFrame: value => {
      try {
        const response = validateCapacityResponse(value);
        if (response.requestId !== request.requestId) throw Error('capacity_unavailable');
        finish(null, response);
      } catch { finish(true); }
    } });
  });
}

function runWithCapacity(run, { query, execute = runCollector, onState = () => {}, pollMs = 1000, renewMs = 10_000 } = {}) {
  const jobId = crypto.createHash('sha256').update(run.id).digest('hex').slice(0, 32);
  const workers = Math.max(1, Math.min(6, run.sourceConfig?.maxConcurrency || 1));
  const controller = new AbortController();
  const renewalController = new AbortController();
  let child = null;
  let cancelled = false;
  let lost = false;
  const request = operation => query({ operation, jobId, workers });
  const sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});
  const promise = (async () => {
    let grant;
    let outcome;
    try {
      onState('waiting_for_capacity');
      while (!cancelled) {
        if (Number.isInteger(run.retry_deadline) && Date.now() >= run.retry_deadline) {
          return { success: false, errorCode: 'polling_window_expired', exitCode: null };
        }
        try { grant = await request('acquire'); }
        catch { grant = null; }
        if (cancelled) break;
        if (grant?.status === 'granted') break;
        await sleep(pollMs, controller.signal);
      }
      if (cancelled) return { success: false, cancelled: true, errorCode: 'cancelled', exitCode: null };
      onState(null);
      child = execute({ ...run, sourceConfig: { ...run.sourceConfig, maxConcurrency: grant.workers } });
      const renewal = (async () => {
        while (!renewalController.signal.aborted) {
          await sleep(renewMs, renewalController.signal);
          if (renewalController.signal.aborted) break;
          try {
            const result = await request('renew');
            if (result.status !== 'granted' || result.workers !== grant.workers) throw Error('capacity_lost');
          } catch { lost = true; child.cancel(); break; }
        }
      })();
      try { outcome = await child.promise; }
      finally { renewalController.abort(); await renewal; }
      return lost ? { success: false, errorCode: 'capacity_lost', exitCode: outcome.exitCode ?? null } : outcome;
    } catch {
      return { success: false, errorCode: 'collector_start_failed', exitCode: null };
    } finally {
      renewalController.abort();
      // A kill failure retains its reservation until expiry instead of handing
      // capacity to another DSP while a child may still be alive.
      if (!child || outcome && outcome.errorCode !== 'collector_kill_failed') { try { await request('release'); } catch {} }
    }
  })();
  return { promise, cancel() { cancelled = true; controller.abort(); child?.cancel(); } };
}
function coordinatedCollector(run, onState) {
  // Core owns admission for installed plugin workers and their browser leases.
  // Waiting on the legacy browser budget here would create a second gate.
  if (process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1') return runCollector(run);
  // Every managed collector uses the host budget, including future plugins.
  if (!['native_service_v1', 'directory_service_v1'].includes(process.env.DISPATCH_RUNTIME_BACKEND)) return runCollector(run);
  const socket = process.env.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET;
  return runWithCapacity(run, { onState, query: input => queryCapacity(socket, input) });
}
module.exports = { queryCapacity, runWithCapacity, coordinatedCollector };
