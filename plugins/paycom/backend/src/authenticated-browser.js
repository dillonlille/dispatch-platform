'use strict';

const { acquireServiceBrowser } = require('../../../../runtime/auth-broker/src/service-client');
const { acquireAuthenticatedBrowser } = require('../../../../runtime/auth-broker/src/browser-client');

const DEFAULT_TTL_SECONDS = 90;

async function acquirePaycomBrowser({ authProfile, runId, ttlSeconds = DEFAULT_TTL_SECONDS, socketPath } = {}) {
  if (!authProfile || authProfile === 'paycom-main') return acquireServiceBrowser({
    service: 'paycom', feature: 'paycom', runId, ttlSeconds, socketPath,
  });
  return acquireAuthenticatedBrowser({
    profile: authProfile,
    collector: 'paycom',
    runId,
    ttlSeconds,
    ...(socketPath ? { socketPath } : {}),
  });
}

async function withPaycomBrowser(options, useBrowser) {
  if (typeof useBrowser !== 'function') throw new TypeError('useBrowser must be a function');
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const lease = await acquirePaycomBrowser({ ...options, ttlSeconds });
  let useError = null;
  let renewError = null;
  let renewPromise = null;
  const heartbeat = setInterval(async () => {
    if (renewPromise || renewError) return;
    renewPromise = lease.renew(ttlSeconds)
      .catch(error => { renewError = error; })
      .finally(() => { renewPromise = null; });
    await renewPromise;
  }, Math.max(10_000, Math.floor(ttlSeconds * 1000 / 3)));
  heartbeat.unref?.();
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    clearInterval(heartbeat);
    Promise.resolve(renewPromise).catch(() => {}).then(() => lease.release()).catch(() => {}).finally(() => process.exit(143));
  };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    const result = await useBrowser({
      protocol: lease.protocol,
      endpoint: lease.endpoint,
      access: lease.access,
      expiresAt: lease.expiresAt,
      renew: seconds => lease.renew(seconds),
      status: () => lease.status(),
    });
    if (renewError) throw renewError;
    return result;
  } catch (error) {
    useError = error;
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    if (renewPromise) await renewPromise.catch(() => {});
    try { await lease.release(); }
    catch (releaseError) { if (!useError) throw releaseError; }
    if (!useError && renewError) throw renewError;
  }
}

module.exports = { acquirePaycomBrowser, withPaycomBrowser, DEFAULT_TTL_SECONDS };
