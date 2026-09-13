'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { PAYCOM_SYNC_ID } = require('../../../shared/paycom-activation');
function instant(value) { return typeof value === 'number' ? value : Date.parse(value); }
function createCanaryVerifier(hub, { clock = Date.now, pollMs = 5000, timeoutMs = 30 * 60_000 } = {}) {
  return async ({ runtimeKey, verificationId, startedAt }) => {
    if (!hub) throw Error('canary_unavailable');
    if (clock() >= startedAt + timeoutMs) throw Error('canary_collection_timeout');
    const invoke = async (action, input) => {
      const result = await hub.invoke(runtimeKey, action, input);
      if (!result?.ok) throw Error('canary_collection_failed');
      return result.data;
    };
    const initial = await invoke('sync.status', { id: PAYCOM_SYNC_ID });
    if (initial.desiredState !== 'running') throw Error('canary_sync_stopped');
    await invoke('sync.run_now', { id: PAYCOM_SYNC_ID, options: { idempotencyKey: verificationId } });
    while (clock() < startedAt + timeoutMs) {
      const status = await invoke('sync.status', { id: PAYCOM_SYNC_ID });
      if (status.desiredState !== 'running' || (!status.activeRun && status.lastError
          && instant(status.lastStartedAt) >= startedAt)) throw Error('canary_collection_failed');
      if (!status.lastError && status.lastSucceededAt !== null && instant(status.lastSucceededAt) >= startedAt) {
        await invoke('collections.health', {});
        return true;
      }
      await delay(pollMs);
    }
    throw Error('canary_collection_timeout');
  };
}
module.exports = { createCanaryVerifier };
