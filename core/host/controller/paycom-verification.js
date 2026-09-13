'use strict';

const { connectionList, connectionView } = require('../../shared/contracts/src/connections');
const { setupFailure, paycomReadiness } = require('../../shared/contracts/src/paycom-setup');
const { success, failure } = require('../../shared/contracts/src/result');
const { MAX_PROVIDER_EVIDENCE_AGE_MS } = require('../../core/accounts/src/installation-activation');

// Onboarding observes the same asynchronous check as Connections. It must not
// launch a second login through a DSP collection runtime.
function createPaycomVerification({ backend, clock = Date.now }) {
  const send = (dspId, input) => backend.request(dspId, 'auth.request', { action: 'connections', input },
    { signal: AbortSignal.timeout(10_000) });
  async function current(dspId) {
    const response = await send(dspId, { command: 'list' });
    if (!response?.ok || response.status !== 'found') throw new Error('auth_unavailable');
    return connectionList({ items: response.items }).items.find(item => item.service === 'paycom');
  }
  async function start(dspId) {
    const response = await send(dspId, { command: 'test', service: 'paycom' });
    // Another check or collector may already own this profile.
    if (!response?.ok && response?.status === 'session_busy') return current(dspId);
    if (!response?.ok || response.status !== 'accepted') throw new Error('auth_unavailable');
    const view = connectionView(response.connection);
    if (view.service !== 'paycom') throw new Error('auth_unavailable');
    return view;
  }
  async function poll(dspId) {
    try {
      let view = await current(dspId);
      const age = clock() - Date.parse(view.checkedAt);
      // Recover a check that never started or a broker interrupted mid-check.
      // Rejected credentials require explicit owner action.
      if (view.state === 'not_verified' || view.reason === 'check_interrupted'
          || view.state === 'connected' && (!Number.isFinite(age) || age < -60_000 || age > MAX_PROVIDER_EVIDENCE_AGE_MS)) {
        view = await start(dspId);
      }
      if (view.state === 'checking') return success('running', null);
      if (view.state === 'connected') return success('succeeded', {
        profileId: 'paycom-main', provider: 'paycom', status: 'authenticated', testedAt: view.checkedAt,
      });
      return failure(setupFailure(view.reason || 'provider_auth_required'));
    } catch { return failure('provider_setup_failed'); }
  }
  async function readiness(dspId) {
    const response = await backend.request(dspId, 'auth.request', { action: 'profile-readiness', profile: 'paycom-main' },
      { signal: AbortSignal.timeout(10_000) });
    if (!response?.ok || response.status !== 'found') throw new Error('auth_unavailable');
    return success('succeeded', paycomReadiness(response.readiness));
  }
  return { start, poll, readiness };
}

module.exports = { createPaycomVerification };
