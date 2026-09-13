'use strict';

const { success, failure, exactObject } = require('dispatch-protocol/contracts/src');
const { setupState, serviceReceipt, SAFE_FAILURES, RECOVERABLE } = require('./setup-auth');

const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const SETUP_PROVIDERS = new Set(['paycom', 'amazon-logistics']);

function invalid() { throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' }); }
function coded(code) { throw Object.assign(new Error(code), { code }); }

function validatePrepareInput(input) {
  exactObject(input, ['provider', 'profile']);
  const provider = input.provider === undefined ? 'paycom' : input.provider;
  const profile = input.profile === undefined ? 'paycom-main' : input.profile;
  if (!SETUP_PROVIDERS.has(provider) || typeof profile !== 'string' || !PROFILE_RE.test(profile)) invalid();
  return { provider, profile };
}

function action(id, available, reason = null) {
  return { id, available, reason: available ? null : reason };
}

async function prepareAuthSetup({ setup, service, ingress }, input = {}) {
  if (!setup || typeof setup.inspect !== 'function'
      || !service || typeof service.status !== 'function'
      || !ingress || typeof ingress.available !== 'function') return failure('invalid_input');

  let values;
  try { values = validatePrepareInput(input); } catch { return failure('invalid_input'); }
  const { provider, profile } = values;

  try {
    const inspected = setupState(await setup.inspect(profile), profile);
    if (inspected.profile.configured && inspected.profile.provider !== provider) coded('profile_provider_mismatch');
    const managed = serviceReceipt(await service.status(), 'status');
    if (inspected.broker === 'ready' && managed.status !== 'ready') coded('broker_state_unknown');
    if (inspected.broker === 'stopped' && managed.status === 'ready') coded('broker_state_unknown');

    const configured = inspected.profile.configured;
    if (configured && (inspected.vault.state !== 'ready' || inspected.vault.profiles < 1)) coded('invalid_component_response');
    const ingressAvailable = Boolean(ingress.available());
    const mutationBlocked = managed.status === 'starting' || (managed.status === 'ready' && !managed.managed);
    const mutationReason = managed.status === 'starting' ? 'broker_starting'
      : managed.status === 'ready' && !managed.managed ? 'auth_broker_unmanaged' : null;
    const enrollAvailable = !configured && ingressAvailable && !mutationBlocked;
    const replaceAvailable = configured && ingressAvailable && !mutationBlocked;
    const removeAvailable = configured && !mutationBlocked;

    return success('ready', {
      workflow: 'setup_auth',
      target: { provider, profile },
      state: {
        broker: { status: managed.status, managed: managed.managed },
        vault: { status: inspected.vault.state, verified: inspected.vault.verified },
        profile: {
          status: configured ? 'configured' : 'not_configured',
          ...(configured ? { provider: inspected.profile.provider } : {}),
        },
        credentialIngress: ingressAvailable ? 'available' : 'unavailable',
      },
      capabilities: {
        credentialActions: [
          action('keep', configured, 'profile_not_configured'),
          action('enroll', enrollAvailable, configured ? 'profile_exists'
            : !ingressAvailable ? 'interactive_terminal_required' : mutationReason),
          action('replace', replaceAvailable, !configured ? 'profile_not_configured'
            : !ingressAvailable ? 'interactive_terminal_required' : mutationReason),
          action('remove', removeAvailable, !configured ? 'profile_not_configured' : mutationReason),
        ],
        authenticationTest: action('run', configured || enrollAvailable, configured || enrollAvailable ? null : 'profile_not_configured'),
      },
      defaults: {
        credentialAction: configured ? 'keep' : 'enroll',
        startBroker: true,
        testAuthentication: false,
      },
    });
  } catch (error) {
    const code = SAFE_FAILURES.has(error?.code) ? error.code
      : SAFE_FAILURES.has(error?.message) ? error.message : 'setup_auth_failed';
    return failure(code, {
      recoverable: RECOVERABLE.has(code),
      data: {
        workflow: 'setup_auth', profile, provider, nextActions: [], cause: null,
        state: { broker: 'unknown', profile: 'unknown', mutation: 'none', recovery: 'not_needed' },
      },
    });
  }
}

module.exports = { prepareAuthSetup, validatePrepareInput };
