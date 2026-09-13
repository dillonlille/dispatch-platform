'use strict';

const crypto = require('node:crypto');
const { success, failure, isResult, exactObject, event } = require('dispatch-protocol/contracts/src');

const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SETUP_PROVIDERS = new Set(['paycom', 'amazon-logistics']);
const RECOVERABLE = new Set([
  'interactive_terminal_required', 'broker_running', 'confirmation_mismatch', 'profile_exists',
  'profile_not_configured', 'attempt_cooldown', 'manual_verification_required', 'cancelled',
  'broker_state_unknown', 'auth_broker_unmanaged', 'auth_broker_start_failed', 'auth_broker_stop_failed',
  'auth_broker_unavailable', 'broker_not_ready', 'primary_credentials_rejected', 'security_answers_rejected', 'invalid_credentials', 'account_locked',
  'mfa_required', 'captcha_required', 'security_challenge',
  'authentication_timeout', 'authentication_failed', 'acquisition_cancelled', 'session_busy', 'maintenance_busy',
  'broker_closing', 'browser_protocol_failed', 'browser_timeout',
  'setup_recovery_failed',
]);
const SAFE_FAILURES = new Set([
  ...RECOVERABLE,
  'invalid_input', 'invalid_request', 'unsafe_storage', 'incomplete_storage', 'vault_integrity_failed', 'profile_limit',
  'helper_unavailable', 'unsafe_executable', 'helper_timeout', 'helper_failed', 'invalid_helper_response',
  'credential_ingress_failed', 'profile_provider_mismatch', 'profile_verification_failed',
  'invalid_component_response', 'event_sink_failed', 'unsafe_service_state', 'service_state_exists',
  'service_identity_unavailable', 'browser_unavailable', 'unsafe_browser', 'browser_start_failed', 'browser_profile_busy',
  'browser_cleanup_failed', 'adapter_unavailable', 'profile_locked', 'attempt_state_invalid', 'session_revoked',
  'maintenance_busy', 'unsafe_maintenance_lock', 'setup_recovery_failed',
]);

function invalid() { throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' }); }
function coded(code) { throw Object.assign(new Error(code), { code }); }
function throwIfCancelled(signal) { if (signal?.aborted) coded('cancelled'); }
function invalidComponent() { coded('invalid_component_response'); }
function componentObject(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalidComponent();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalidComponent();
  return value;
}
function setupState(value, expectedProfile) {
  componentObject(value, ['broker', 'vault', 'profile'], ['broker', 'vault', 'profile']);
  componentObject(value.vault, ['state', 'verified', 'schemaVersion', 'profiles'], ['state', 'verified', 'schemaVersion', 'profiles']);
  componentObject(value.profile, ['configured', 'profile', 'provider'], ['configured', 'profile']);
  if (!['ready', 'stopped'].includes(value.broker) || !['ready', 'absent'].includes(value.vault.state)
      || typeof value.vault.verified !== 'boolean' || !Number.isInteger(value.vault.profiles)
      || value.vault.profiles < 0 || value.vault.profiles > 128
      || typeof value.profile.configured !== 'boolean' || value.profile.profile !== expectedProfile) invalidComponent();
  if (value.vault.state === 'ready') {
    if (value.vault.verified !== true || !Number.isInteger(value.vault.schemaVersion) || value.vault.schemaVersion < 1) invalidComponent();
  } else if (value.vault.verified !== false || value.vault.schemaVersion !== null || value.vault.profiles !== 0) invalidComponent();
  if (value.profile.configured) {
    if (typeof value.profile.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value.profile.provider)) invalidComponent();
  } else if (Object.hasOwn(value.profile, 'provider')) invalidComponent();
  return {
    broker: value.broker,
    vault: { state: value.vault.state, verified: value.vault.verified, schemaVersion: value.vault.schemaVersion, profiles: value.vault.profiles },
    profile: { configured: value.profile.configured, profile: expectedProfile, ...(value.profile.configured ? { provider: value.profile.provider } : {}) },
  };
}
function captureReceipt(value, provider, profile) {
  componentObject(value, ['profile', 'provider', 'stored'], ['profile', 'provider', 'stored']);
  if (value.profile !== profile || value.provider !== provider || value.stored !== true) invalidComponent();
}
function removalReceipt(value, profile) {
  componentObject(value, ['profile', 'removed'], ['profile', 'removed']);
  if (value.profile !== profile || value.removed !== true) invalidComponent();
}
function serviceReceipt(value, operation) {
  componentObject(value, ['status', 'managed', 'started', 'stopped'], ['status', 'managed']);
  if (!['ready', 'starting', 'stopped'].includes(value.status) || typeof value.managed !== 'boolean') invalidComponent();
  if (operation === 'start' && (value.status !== 'ready' || typeof value.started !== 'boolean')) invalidComponent();
  if (operation === 'stop' && (value.status !== 'stopped' || typeof value.stopped !== 'boolean')) invalidComponent();
  if (operation === 'status' && (Object.hasOwn(value, 'started') || Object.hasOwn(value, 'stopped'))) invalidComponent();
  return { status: value.status, managed: value.managed,
    ...(operation === 'start' ? { started: value.started } : {}),
    ...(operation === 'stop' ? { stopped: value.stopped } : {}) };
}
function authenticationReceipt(value, provider, profile) {
  if (!isResult(value)) invalidComponent();
  if (!value.ok) {
    if (!SAFE_FAILURES.has(value.status)) invalidComponent();
    coded(value.status);
  }
  if (value.status !== 'authenticated') invalidComponent();
  componentObject(value.data, ['profile', 'provider', 'testedAt'], ['profile', 'provider', 'testedAt']);
  if (value.data.profile !== profile || value.data.provider !== provider || typeof value.data.testedAt !== 'string'
      || Number.isNaN(Date.parse(value.data.testedAt))) invalidComponent();
  return { profile, provider, testedAt: value.data.testedAt };
}

function failureActions(code, recovery) {
  if (recovery === 'failed') return ['start_auth_broker', 'run_status', 'retry_setup'];
  if (code === 'broker_running') return ['stop_auth_broker', 'retry_setup'];
  if (code === 'auth_broker_unmanaged') return ['stop_auth_broker_manually', 'retry_setup'];
  if (code === 'interactive_terminal_required') return ['open_local_terminal', 'retry_setup'];
  if (code === 'broker_state_unknown') return ['run_status', 'retry_setup'];
  if (code === 'auth_broker_start_failed') return ['start_auth_broker', 'run_status', 'retry_setup'];
  if (['cancelled', 'acquisition_cancelled'].includes(code)) return ['retry_setup'];
  return [];
}
function validateInput(input) {
  exactObject(input, ['provider', 'profile', 'credentialAction', 'replaceExisting', 'startBroker', 'testAuthentication', 'operationId']);
  const provider = input.provider === undefined ? 'paycom' : input.provider;
  const profile = input.profile === undefined ? 'paycom-main' : input.profile;
  const replaceExisting = input.replaceExisting === undefined ? false : input.replaceExisting;
  const credentialAction = input.credentialAction === undefined
    ? (replaceExisting ? 'replace_or_enroll' : 'auto') : input.credentialAction;
  const startBroker = input.startBroker === undefined ? true : input.startBroker;
  const testAuthentication = input.testAuthentication === undefined ? false : input.testAuthentication;
  const operationId = input.operationId === undefined ? `setup_auth_${crypto.randomUUID().replaceAll('-', '')}` : input.operationId;
  if (!SETUP_PROVIDERS.has(provider) || typeof profile !== 'string' || !PROFILE_RE.test(profile)
      || (input.credentialAction !== undefined && input.replaceExisting !== undefined)
      || !['auto', 'keep', 'enroll', 'replace', 'remove', 'replace_or_enroll'].includes(credentialAction)
      || (credentialAction === 'replace_or_enroll' && input.credentialAction !== undefined)
      || typeof replaceExisting !== 'boolean' || typeof startBroker !== 'boolean' || typeof testAuthentication !== 'boolean'
      || credentialAction === 'remove' && testAuthentication
      || typeof operationId !== 'string' || !OPERATION_RE.test(operationId)) invalid();
  return { provider, profile, credentialAction, startBroker, testAuthentication, operationId };
}

async function runSetupAuth({ setup, ingress, service, authentication, events, signal = null }, input = {}) {
  if (!setup || typeof setup.inspect !== 'function' || typeof setup.initialize !== 'function'
      || !ingress || typeof ingress.available !== 'function' || typeof ingress.capture !== 'function'
      || !service || typeof service.status !== 'function' || typeof service.start !== 'function' || typeof service.stop !== 'function'
      || !authentication || typeof authentication.testProfile !== 'function'
      || (signal !== null && signal !== undefined && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))
      || !events || typeof events.emit !== 'function') return failure('invalid_input');

  let values;
  try { values = validateInput(input); } catch { return failure('invalid_input'); }
  const { provider, profile, credentialAction, startBroker, testAuthentication, operationId } = values;
  const emit = async (type, data) => {
    try { await events.emit(event(type, data, { operationId })); }
    catch {}
  };
  let initialBroker = null;
  let stoppedManagedBroker = false;
  let mutation = 'none';

  try {
    throwIfCancelled(signal);
    await emit('workflow_started', { workflow: 'setup_auth', state: 'preflight' });
    await emit('step_started', { step: 'preflight' });
    let state = setupState(await setup.inspect(profile), profile);
    initialBroker = state.broker;
    await emit('check_completed', { check: 'broker_state', status: state.broker });
    await emit('check_completed', { check: 'vault_state', status: state.vault.state });

    if (state.profile.configured && state.profile.provider && state.profile.provider !== provider) coded('profile_provider_mismatch');
    if (credentialAction === 'keep' && !state.profile.configured) coded('profile_not_configured');
    if (credentialAction === 'enroll' && state.profile.configured) coded('profile_exists');
    if (credentialAction === 'replace' && !state.profile.configured) coded('profile_not_configured');
    if (credentialAction === 'remove' && !state.profile.configured) coded('profile_not_configured');
    const needsCapture = credentialAction === 'auto' ? !state.profile.configured
      : ['enroll', 'replace', 'replace_or_enroll'].includes(credentialAction);
    const needsMutation = needsCapture || credentialAction === 'remove';

    if (needsCapture) {
      throwIfCancelled(signal);
      if (!ingress.available()) coded('interactive_terminal_required');
      await emit('check_completed', { check: 'interactive_terminal', status: 'ready' });
    }

    if (needsMutation && state.broker === 'ready') {
      const running = serviceReceipt(await service.status(), 'status');
      if (!running.managed) coded('auth_broker_unmanaged');
      await emit('step_started', { step: 'stop_broker' });
      const stopped = serviceReceipt(await service.stop(), 'stop');
      stoppedManagedBroker = stopped.stopped;
      state = setupState(await setup.inspect(profile), profile);
      if (state.broker !== 'stopped') coded('auth_broker_stop_failed');
      await emit('check_completed', { check: 'broker_state', status: 'stopped' });
    }

    if (credentialAction === 'remove') {
      throwIfCancelled(signal);
      if (typeof setup.remove !== 'function') invalidComponent();
      await emit('step_started', { step: 'remove_profile' });
      removalReceipt(await setup.remove(profile), profile);
      mutation = 'removed';
      await emit('step_started', { step: 'verify_profile' });
      let removed = setupState(await setup.inspect(profile), profile);
      if (removed.vault.state !== 'ready' || removed.vault.verified !== true || removed.profile.configured) {
        coded('profile_verification_failed');
      }
      await emit('check_completed', { check: 'profile_state', status: 'removed' });
      if (startBroker && removed.broker !== 'ready') {
        await emit('step_started', { step: 'start_broker' });
        serviceReceipt(await service.start(), 'start');
        removed = setupState(await setup.inspect(profile), profile);
        if (removed.broker !== 'ready' || removed.profile.configured) coded('auth_broker_start_failed');
        stoppedManagedBroker = false;
        await emit('check_completed', { check: 'broker_state', status: 'ready' });
      }
      await emit('workflow_completed', { workflow: 'setup_auth', status: 'complete' });
      return success('complete', {
        workflow: 'setup_auth', provider, profile, configured: false,
        broker: removed.broker, vault: 'verified', authenticationTest: 'skipped',
        nextActions: ['configure_auth_profile'],
      });
    }

    if (needsCapture) {
      if (state.vault.state === 'absent') {
        await emit('step_started', { step: 'initialize_vault' });
        await setup.initialize();
        state = setupState(await setup.inspect(profile), profile);
        if (state.vault.state !== 'ready' || state.vault.verified !== true) coded('profile_verification_failed');
        await emit('check_completed', { check: 'vault_integrity', status: 'verified' });
      }

      const operation = state.profile.configured ? 'replace' : 'enroll';
      await emit('step_started', { step: 'capture_profile' });
      await emit('credential_capture_started', { provider, profile });
      captureReceipt(await ingress.capture({ operation, provider, profile }), provider, profile);
      mutation = operation === 'replace' ? 'replaced' : 'enrolled';
      throwIfCancelled(signal);
      await emit('credential_capture_completed', { provider, profile, status: 'stored' });
    }

    await emit('step_started', { step: 'verify_profile' });
    let verified = setupState(await setup.inspect(profile), profile);
    if (verified.vault.state !== 'ready' || verified.vault.verified !== true || verified.profile.configured !== true
        || verified.profile.provider !== provider) coded('profile_verification_failed');
    await emit('check_completed', { check: 'profile_state', status: 'verified' });

    if (startBroker && verified.broker !== 'ready') {
      throwIfCancelled(signal);
      await emit('step_started', { step: 'start_broker' });
      serviceReceipt(await service.start(), 'start');
      throwIfCancelled(signal);
      verified = setupState(await setup.inspect(profile), profile);
      if (verified.broker !== 'ready') coded('auth_broker_start_failed');
      stoppedManagedBroker = false;
      await emit('check_completed', { check: 'broker_state', status: 'ready' });
    }

    let authenticationTest = 'skipped';
    if (testAuthentication) {
      if (verified.broker !== 'ready') coded('broker_not_ready');
      await emit('step_started', { step: 'test_authentication' });
      authenticationReceipt(await authentication.testProfile(profile, { signal }), provider, profile);
      throwIfCancelled(signal);
      authenticationTest = 'authenticated';
      await emit('check_completed', { check: 'authentication', status: 'authenticated' });
    }

    await emit('workflow_completed', { workflow: 'setup_auth', status: 'complete' });
    return success('complete', {
      workflow: 'setup_auth', provider, profile, configured: true,
      broker: verified.broker, vault: 'verified', authenticationTest,
      nextActions: verified.broker === 'ready' ? ['run_collection'] : ['start_auth_broker', 'run_collection'],
    });
  } catch (error) {
    const originalCode = SAFE_FAILURES.has(error?.code) ? error.code
      : SAFE_FAILURES.has(error?.message) ? error.message : 'setup_auth_failed';
    let recovery = 'not_needed';
    if (stoppedManagedBroker && initialBroker === 'ready') {
      recovery = 'failed';
      try {
        serviceReceipt(await service.start(), 'start');
        const restored = setupState(await setup.inspect(profile), profile);
        if (restored.broker !== 'ready') throw new Error('auth_broker_start_failed');
        stoppedManagedBroker = false;
        recovery = 'restored';
      } catch {}
    }
    let observedBroker = stoppedManagedBroker ? 'stopped' : initialBroker || 'unknown';
    let observedProfile = 'unknown';
    try {
      const observed = setupState(await setup.inspect(profile), profile);
      observedBroker = observed.broker;
      observedProfile = observed.profile.configured ? 'configured' : 'not_configured';
    } catch {}
    const code = recovery === 'failed' ? 'setup_recovery_failed' : originalCode;
    return failure(code, {
      recoverable: RECOVERABLE.has(code),
      data: {
        workflow: 'setup_auth', profile, provider,
        nextActions: failureActions(originalCode, recovery),
        cause: recovery === 'failed' ? originalCode : null,
        state: { broker: observedBroker, profile: observedProfile, mutation, recovery },
      },
    });
  }
}

class RecordingEventSink {
  constructor() { this.events = []; }
  emit(value) { this.events.push(value); }
}

module.exports = {
  runSetupAuth, RecordingEventSink, SAFE_FAILURES, RECOVERABLE, validateInput,
  setupState, captureReceipt, removalReceipt, serviceReceipt, authenticationReceipt, failureActions,
};
