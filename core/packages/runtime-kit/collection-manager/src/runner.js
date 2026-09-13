'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { parseStrictJson } = require('dispatch-runtime-kit/collection-manager/src/strict-json');
const {
  resolveLocalRuntimePaths,
  runtimeEnvironment,
  managedRuntimeEnvironmentFromProcess,
} = require('dispatch-protocol/paths/runtime-paths');
const { boundedJson, plainObject } = require('dispatch-runtime-kit/collection-manager/src/validation');
const { safeExecutable } = require('dispatch-runtime-kit/collection-manager/src/store');
const { trustedCommandPath } = require('dispatch-protocol/trusted-command-path');

const MAX_STDOUT_BYTES = 65_536;
const MAX_STDERR_BYTES = 16_384;
// Authenticated collectors may need to finish a bounded broker release before
// they exit. Poll so ordinary collectors still terminate promptly, but do not
// SIGKILL a cooperative collector while its lease cleanup is in flight.
const KILL_GRACE_MS = 22_000;
const SUCCESS_STATUSES = new Set(['succeeded', 'published', 'no_change']);

function errorCode(value, fallback = 'collector_failed') {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function validateReceipt(value) {
  if (!plainObject(value) || typeof value.ok !== 'boolean' || typeof value.status !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(value.status)) throw new Error('invalid_receipt');
  const allowed = new Set(['ok', 'status', 'data', 'warnings', 'error']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('invalid_receipt');
  if (value.data !== undefined) boundedJson(value.data, { maxBytes: 48_000 });
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 32
      || value.warnings.some(item => typeof item !== 'string' || item.length > 512))) throw new Error('invalid_receipt');
  if (value.error !== undefined) {
    if (!plainObject(value.error) || Object.keys(value.error).some(key => !['code'].includes(key))
        || errorCode(value.error.code, 'invalid_receipt') === 'invalid_receipt') throw new Error('invalid_receipt');
  }
  boundedJson(value, { maxBytes: MAX_STDOUT_BYTES });
  if (value.ok !== SUCCESS_STATUSES.has(value.status)) throw new Error('invalid_receipt');
  return value;
}

function collectorRuntimeEnvironment(environment = process.env) {
  return Object.hasOwn(environment, 'DISPATCH_MANAGED_RUNTIME')
    ? managedRuntimeEnvironmentFromProcess(environment)
    : runtimeEnvironment(resolveLocalRuntimePaths());
}

function runCollector(run) {
  const coreBackend = process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1';
  if (!coreBackend) safeExecutable(run.command);
  const startedAt = Date.now();
  const ordinaryDeadline = startedAt + run.timeout_seconds * 1000;
  const absoluteDeadline = Number.isInteger(run.retry_deadline)
    ? Math.min(ordinaryDeadline, run.retry_deadline) : ordinaryDeadline;
  const timeoutMs = Math.max(1, absoluteDeadline - startedAt);
  const deadlineReason = Number.isInteger(run.retry_deadline) && run.retry_deadline <= ordinaryDeadline
    ? 'polling_window_expired' : 'collector_timeout';
  const request = {
    protocolVersion: 1,
    runId: run.id,
    plan: run.plan_id,
    source: {
      id: run.source_id,
      collector: run.collector_id,
      authProfile: run.auth_profile,
      config: run.sourceConfig,
    },
    method: run.method_id,
    input: run.input,
    attempt: run.attempt,
    deadline: new Date(absoluteDeadline).toISOString(),
  };
  boundedJson(request, { maxBytes: 65_536 });
  if (coreBackend) {
    const controller = new AbortController();
    const owner = require('dispatch-protocol/plugin-sdk/catalog').catalog().find(plugin => plugin.collectors.includes(run.collector_id));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let cancelled = false;
    const promise = Promise.resolve().then(async () => {
      if (!owner) throw new Error('collector_unavailable');
      const receipt = validateReceipt(await require('dispatch-sdk/runtime').createFrameworkClient().request('plugin.collect',
        { pluginId: owner.id, request }, { signal: controller.signal }));
      return receipt.ok ? { success: true, receipt, exitCode: 0 }
        : { success: false, errorCode: errorCode(receipt.error?.code), exitCode: 0 };
    }).catch(error => ({ success: false, ...(cancelled ? { cancelled: true } : {}), exitCode: null,
      errorCode: controller.signal.aborted ? cancelled ? 'cancelled' : deadlineReason : errorCode(error.code) }))
      .finally(() => clearTimeout(timer));
    return { promise, cancel: () => { cancelled = true; controller.abort(); } };
  }

  let child;
  let settled = false;
  let timeout = null;
  let terminating = false;
  let promiseCancel = () => {};
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const promise = new Promise(resolve => {
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(outcome);
    };
    const killGroup = signal => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, signal); }
      catch {
        try { child.kill(signal); } catch {}
      }
    };
    const groupAlive = () => {
      if (!child?.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const delay = ms => new Promise(done => setTimeout(done, ms));
    const terminate = reason => {
      if (settled || terminating) return;
      terminating = true;
      const outcomes = {
        cancelled: { success: false, cancelled: true, errorCode: 'cancelled', exitCode: child?.exitCode ?? null },
        timeout: { success: false, errorCode: deadlineReason, exitCode: child?.exitCode ?? null },
        output_limit: { success: false, errorCode: 'collector_output_limit', exitCode: child?.exitCode ?? null },
        input_failed: { success: false, errorCode: 'collector_input_failed', exitCode: child?.exitCode ?? null },
      };
      const outcome = outcomes[reason] || { success: false, errorCode: 'collector_terminated', exitCode: null };
      (async () => {
        if (!child?.pid) return finish(outcome);
        killGroup('SIGTERM');
        const graceDeadline = Date.now() + KILL_GRACE_MS;
        while (groupAlive() && Date.now() < graceDeadline) await delay(25);
        if (groupAlive()) killGroup('SIGKILL');
        for (let index = 0; index < 200 && groupAlive(); index++) await delay(25);
        if (groupAlive()) return finish({ success: false, errorCode: 'collector_kill_failed', exitCode: child.exitCode ?? null });
        finish({ ...outcome, exitCode: child.exitCode ?? outcome.exitCode });
      })().catch(() => finish({ success: false, errorCode: 'collector_kill_failed', exitCode: child?.exitCode ?? null }));
    };
    try {
      child = spawn(run.command, [], {
        cwd: path.dirname(run.command),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: {
          PATH: trustedCommandPath(),
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TZ: 'UTC',
          NODE_NO_WARNINGS: '1',
          ...collectorRuntimeEnvironment(),
        },
      });
    } catch {
      finish({ success: false, errorCode: 'collector_start_failed', exitCode: null });
      return;
    }
    timeout = setTimeout(() => terminate('timeout'), timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) terminate('output_limit');
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) terminate('output_limit');
    });
    child.on('error', () => { if (!terminating) finish({ success: false, errorCode: 'collector_start_failed', exitCode: null }); });
    child.on('close', (code, signal) => {
      if (settled || terminating) return;
      if (stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > MAX_STDERR_BYTES) return finish({ success: false, errorCode: 'collector_output_limit', exitCode: code });
      if (signal) return finish({ success: false, errorCode: 'collector_terminated', exitCode: code });
      if (code !== 0) return finish({ success: false, errorCode: 'collector_exit_nonzero', exitCode: code });
      try {
        const text = Buffer.concat(stdout).toString('utf8');
        if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) throw new Error('invalid_receipt');
        const receipt = validateReceipt(parseStrictJson(text.slice(0, -1)));
        if (!receipt.ok) return finish({ success: false, errorCode: errorCode(receipt.error?.code), exitCode: code });
        finish({ success: true, receipt, exitCode: code });
      } catch {
        finish({ success: false, errorCode: 'invalid_receipt', exitCode: code });
      }
    });
    child.stdin.on('error', () => terminate('input_failed'));
    child.stdin.end(`${JSON.stringify(request)}\n`);
    promiseCancel = () => terminate('cancelled');
  });
  return { promise, cancel: () => promiseCancel() };
}

module.exports = {
  runCollector,
  validateReceipt,
  collectorRuntimeEnvironment,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
};
