'use strict';

const { acquireServiceBrowser } = require('../../../runtime/auth-broker/src/service-client');
const { acquireAuthenticatedBrowser } = require('../../../runtime/auth-broker/src/browser-client');

const DEFAULT_TTL_SECONDS = 180;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateDeadline(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('invalid_request');
  if (Date.now() >= Date.parse(value)) fail('deadline_exceeded');
  return value;
}

async function acquireCdfBrowser({
  authProfile, runId, deadline, ttlSeconds = DEFAULT_TTL_SECONDS, socketPath, signal = null,
} = {}) {
  validateDeadline(deadline);
  if (!authProfile || authProfile === 'amazon-operations') return acquireServiceBrowser({
    service: 'cortex', feature: 'cdf', runId, ttlSeconds, socketPath, signal,
  });
  return acquireAuthenticatedBrowser({
    profile: authProfile,
    collector: 'cdf',
    runId,
    ttlSeconds,
    signal,
    ...(socketPath ? { socketPath } : {}),
  });
}

async function withCdfBrowser(options, useBrowser, { acquireBrowser = acquireCdfBrowser } = {}) {
  if (typeof useBrowser !== 'function' || typeof acquireBrowser !== 'function') throw new TypeError('invalid_browser_callback');
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const deadline = validateDeadline(options?.deadline);
  const controller = new AbortController();
  const externalSignal = options?.signal || null;
  const externalAbort = () => controller.abort();
  let deadlineExpired = false;
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, Math.max(1, Date.parse(deadline) - Date.now()));
  let lease = null;
  let heartbeat = null;
  let renewPromise = null;
  let renewError = null;
  let releasePromise = null;
  let cleanupPromise = null;
  let acquisitionPromise = null;
  let terminating = false;

  const releaseOnce = () => {
    if (!lease) return Promise.resolve();
    if (!releasePromise) releasePromise = Promise.resolve().then(() => lease.release());
    return releasePromise;
  };
  const cleanupOnce = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        clearTimeout(deadlineTimer);
        clearInterval(heartbeat);
        controller.abort();
        if (renewPromise) await renewPromise.catch(() => {});
        await releaseOnce();
      })().finally(() => {
        externalSignal?.removeEventListener('abort', externalAbort);
        process.removeListener('SIGTERM', terminate);
        process.removeListener('SIGINT', terminate);
      });
    }
    return cleanupPromise;
  };
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    controller.abort();
    Promise.resolve(acquisitionPromise).catch(() => {}).then(cleanupOnce).catch(() => {})
      .finally(() => process.exit(143));
  };

  externalSignal?.addEventListener('abort', externalAbort, { once: true });
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  if (externalSignal?.aborted) controller.abort();

  let useError = null;
  acquisitionPromise = Promise.resolve().then(() => acquireBrowser({
    ...options, ttlSeconds, signal: controller.signal,
  }));
  try {
    lease = await acquisitionPromise;
    validateDeadline(deadline);
    if (controller.signal.aborted) fail('acquisition_cancelled');

    heartbeat = setInterval(() => {
      if (renewPromise || renewError || controller.signal.aborted) return;
      renewPromise = Promise.resolve().then(() => lease.renew(ttlSeconds))
        .catch(error => { renewError = error; controller.abort(); })
        .finally(() => { renewPromise = null; });
    }, Math.max(10_000, Math.floor(ttlSeconds * 1000 / 3)));
    heartbeat.unref?.();

    const result = await useBrowser({
      endpoint: lease.endpoint,
      protocol: lease.protocol,
      access: lease.access,
      expiresAt: lease.expiresAt,
      signal: controller.signal,
      renew: seconds => lease.renew(seconds),
      status: () => lease.status(),
    });
    validateDeadline(deadline);
    if (renewError) throw renewError;
    if (controller.signal.aborted) fail('acquisition_cancelled');
    return result;
  } catch (error) {
    useError = error;
    if (deadlineExpired || Date.now() >= Date.parse(deadline)) fail('deadline_exceeded');
    if (externalSignal?.aborted && error?.code !== 'deadline_exceeded') fail('acquisition_cancelled');
    throw error;
  } finally {
    try { await cleanupOnce(); }
    catch (cleanupError) {
      if (!['lease_not_found', 'session_revoked'].includes(cleanupError?.code)) throw cleanupError;
      if (!useError) throw cleanupError;
    }
    if (!useError) {
      if (deadlineExpired || Date.now() >= Date.parse(deadline)) fail('deadline_exceeded');
      if (externalSignal?.aborted) fail('acquisition_cancelled');
      if (renewError) throw renewError;
    }
  }
}

module.exports = { DEFAULT_TTL_SECONDS, validateDeadline, acquireCdfBrowser, withCdfBrowser };
