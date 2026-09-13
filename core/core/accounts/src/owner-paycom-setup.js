'use strict';

const crypto = require('node:crypto');
const { AccessError, exact, idempotencyKey } = require('./validation');
const { paycomCredentials, setupFailure, paycomReadiness } = require('../../../shared/contracts/src/paycom-setup');
const { managedInstallationContext } = require('./installation-authority');
const { createAccessInstallationActivationAuthority } = require('./installation-activation');
const { createOnboardingStore } = require('./onboarding-store');
function fail(code, status = 409) { throw new AccessError(code, status); }
function createOwnerPaycomSetup({ store, access, invoke, clock = Date.now,
  beginVerification = null, readReadiness = null,
  enroll = (key, input) => invoke(key, 'paycom.setup', input) }) {
  const requests = createOnboardingStore(store, clock);
  function context(session) {
    require('./plugins').requirePlugin(access, session, 'paycom');
    const { organization } = access.requireDspOwner(session);
    const context = managedInstallationContext(store, organization.id);
    const profile = store.db.prepare('SELECT applied_at FROM organization_profiles WHERE organization_id=?').get(organization.id);
    if (profile && profile.applied_at === null) fail('organization_details_required');
    if (!['oci_container_v1', 'native_service_v1', 'directory_service_v1'].includes(context.backend)) fail('installation_operation_not_allowed');
    return context;
  }
  function view(context) {
    const row = requests.latest(context.organization.id);
    const idle = !store.activeLifecycleJob(context.organization.id);
    const workforceAvailable = Boolean(store.latestReadyEvidence(context.organization.id));
    const connected = workforceAvailable || row?.status === 'succeeded';
    return {
      installationState: context.installation.status, workforceAvailable,
      status: row?.status || (connected ? 'succeeded' : 'not_started'), failureCode: row?.failure_code || null,
      canSubmit: idle && !connected && ['ready', 'waiting_for_provider_auth'].includes(context.installation.status)
        && (!row || ['succeeded', 'failed'].includes(row.status)),
      canRetry: false, retryState: null, retryAt: null,
    };
  }
  async function status(session) {
    const selected = context(session);
    const row = requests.latest(selected.organization.id);
    const result = view(selected);
    if (row?.status !== 'failed' || store.activeLifecycleJob(selected.organization.id)
        || !['failed', 'ready', 'verifying', 'waiting_for_provider_auth'].includes(selected.installation.status)) return result;
    let readiness;
    try {
      const response = readReadiness ? await readReadiness(selected.manifest.runtime.key)
        : await invoke(selected.manifest.runtime.key, 'paycom.setup', {
        command: 'status', requestId: row.id, step: 'readiness', manifest: selected.manifest,
        manifestAuthority: selected.manifestAuthority, parameters: {},
      });
      if (!response?.ok || response.status !== 'succeeded') throw new Error('readiness_unavailable');
      readiness = paycomReadiness(response.data);
    } catch { readiness = { state: 'unavailable', retryAllowed: false, retryAt: null }; }
    // Reauthorize after transport; a replacement or lifecycle operation may have won.
    const current = context(session);
    const latest = requests.latest(current.organization.id);
    if (latest?.id !== row.id || latest?.fence !== row.fence || latest?.status !== 'failed'
        || current.installation.revision !== selected.installation.revision
        || current.installation.status !== selected.installation.status
        || JSON.stringify(current.manifest) !== JSON.stringify(selected.manifest)
        || store.activeLifecycleJob(current.organization.id)) return view(current);
    return { ...result, canRetry: readiness.retryAllowed, retryState: readiness.state, retryAt: readiness.retryAt };
  }
  async function submit(session, input) {
    access.requireDspOwner(session);
    exact(input, ['idempotencyKey', 'intent', 'credentials']);
    idempotencyKey(input.idempotencyKey);
    if (!['create', 'replace'].includes(input.intent)) fail('invalid_input', 400);
    let credentials;
    try { credentials = paycomCredentials(input.credentials); }
    catch { fail('paycom_credentials_invalid', 400); }
    let selected = context(session);
    const prior = requests.prior(selected.organization.id, session.user.id, input.idempotencyKey);
    if (prior) {
      if (prior.intent !== input.intent) fail('idempotency_conflict');
      return { ...view(selected), replayed: true };
    }
    if (!['ready', 'waiting_for_provider_auth'].includes(selected.installation.status)) fail('installation_not_ready');
    if (store.latestReadyEvidence(selected.organization.id) || requests.latest(selected.organization.id)?.status === 'succeeded') fail('installation_operation_not_allowed');
    if (selected.installation.status === 'ready') {
      // Changing an established connection requires a separate reconnect workflow.
      // Failed initial login verification can retry.
      let row;
      const guard = () => {
        const current = context(session);
        if (current.installation.status !== 'ready' || current.organization.status !== 'active'
            || current.installation.revision !== selected.installation.revision
            || store.activeLifecycleJob(selected.organization.id)
            || store.runningActivationJob(selected.organization.id)
            || store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(selected.organization.id)) fail('installation_operation_in_progress');
      };
      try {
        store.transaction(() => {
          guard();
          row = requests.begin(selected.organization.id, session.user.id, input.idempotencyKey, input.intent, selected.manifest.revision);
        });
        const result = await enroll(selected.manifest.runtime.key, {
          command: 'enroll', requestId: row.id, expiresAt: clock() + 30_000, credentials, intent: input.intent,
        });
        if (!result?.ok || result.status !== 'succeeded' || result.data?.configured !== true) fail(setupFailure(result?.status));
        store.transaction(() => { guard(); requests.enrolled(row.id); });
        return { ...view(context(session)), replayed: false };
      } catch (error) {
        if (row) requests.enrollmentFailed(row.id, setupFailure(error?.code));
        if (error instanceof AccessError) throw error;
        fail('provider_setup_failed');
      }
    }
    const authority = createAccessInstallationActivationAuthority({
      store, organizationId: selected.organization.id, authorityScope: 'owner_onboarding',
      workerId: `owner_${crypto.randomBytes(16).toString('hex')}`, idempotencyKey: input.idempotencyKey,
      clock, setupLeaseMs: 180_000, releaseId: selected.manifest.runtime.releaseId,
    });
    authority.beginSetup();
    let row;
    try {
      row = requests.begin(selected.organization.id, session.user.id, input.idempotencyKey, input.intent, selected.manifest.revision);
      authority.guard(() => true);
      const result = await enroll(selected.manifest.runtime.key, {
        command: 'enroll', requestId: row.id, expiresAt: clock() + 30_000, credentials, intent: input.intent,
      });
      authority.guard(() => true);
      if (!result?.ok || result.status !== 'succeeded' || result.data?.configured !== true) fail(setupFailure(result?.status));
      // Reauthorize after transport completion before making the queued work visible.
      selected = context(session);
      requests.enrolled(row.id);
      return { ...view(selected), replayed: false };
    } catch (error) {
      if (row) requests.enrollmentFailed(row.id, setupFailure(error?.code));
      if (error instanceof AccessError) throw error;
      fail('provider_setup_failed');
    } finally { authority.endSetup(); }
  }
  async function retry(session, input) {
    access.requireDspOwner(session);
    exact(input, []);
    const selected = context(session);
    const row = requests.latest(selected.organization.id);
    const readiness = await status(session);
    if (!readiness.canRetry) fail('installation_operation_not_allowed');
    const guard = () => {
      const current = context(session);
      const latest = requests.latest(current.organization.id);
      if (latest?.id !== row?.id || latest?.fence !== row?.fence || latest?.status !== 'failed'
          || current.installation.revision !== selected.installation.revision
          || current.installation.status !== selected.installation.status
          || JSON.stringify(current.manifest) !== JSON.stringify(selected.manifest)
          || store.activeLifecycleJob(current.organization.id)) fail('installation_operation_in_progress');
    };
    guard();
    // An owner retry starts a fresh check before the worker sees the request.
    if (beginVerification) {
      try { await beginVerification(selected.manifest.runtime.key); }
      catch { fail('auth_unavailable', 503); }
      guard();
    }
    if (['ready', 'verifying', 'waiting_for_provider_auth'].includes(selected.installation.status)) {
      store.transaction(() => {
        const row = requests.latest(selected.organization.id);
        requests.requeue(row.id);
        if (selected.installation.status === 'ready') store.db.prepare('UPDATE installation_onboarding_requests SET manifest_revision=? WHERE id=?').run(selected.manifest.revision, row.id);
      });
      return view(selected);
    }
    const authority = createAccessInstallationActivationAuthority({
      store, organizationId: selected.organization.id, authorityScope: 'owner_onboarding',
      workerId: `owner_${crypto.randomBytes(16).toString('hex')}`, idempotencyKey: requests.latest(selected.organization.id).id,
      clock, releaseId: selected.manifest.runtime.releaseId,
    });
    authority.retry();
    return view(context(session));
  }
  return { status, submit, retry };
}
module.exports = { createOwnerPaycomSetup };
