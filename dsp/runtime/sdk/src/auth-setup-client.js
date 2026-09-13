'use strict';

const { success, failure, isResult, exactObject, STATUS_RE } = require('dispatch-protocol/contracts/src');
const { SAFE_FAILURES } = require('../../application/auth/setup-auth');

const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SETUP_PROVIDERS = new Set(['paycom', 'amazon-logistics']);
const CREDENTIAL_ACTIONS = new Set(['auto', 'keep', 'enroll', 'replace', 'remove']);
const BROKER_STATES = new Set(['ready', 'starting', 'stopped']);
const VAULT_STATES = new Set(['ready', 'absent']);
const PUBLIC_FAILURES = new Set([...SAFE_FAILURES, 'setup_auth_failed']);

function invalid() { throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' }); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) { return plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function safeCode(value) { return value === null || typeof value === 'string' && STATUS_RE.test(value); }

function validateTarget(value) {
  if (!exact(value, ['provider', 'profile']) || !SETUP_PROVIDERS.has(value.provider)
      || typeof value.profile !== 'string' || !PROFILE_RE.test(value.profile)) throw new Error('invalid_component_response');
  return { provider: value.provider, profile: value.profile };
}

function validateAction(value, expectedId) {
  if (!exact(value, ['id', 'available', 'reason']) || value.id !== expectedId
      || typeof value.available !== 'boolean' || !safeCode(value.reason)
      || (value.available && value.reason !== null) || (!value.available && value.reason === null)) throw new Error('invalid_component_response');
  return { id: value.id, available: value.available, reason: value.reason };
}

function preparationData(value) {
  if (!exact(value, ['workflow', 'target', 'state', 'capabilities', 'defaults']) || value.workflow !== 'setup_auth') throw new Error('invalid_component_response');
  const target = validateTarget(value.target);
  if (!exact(value.state, ['broker', 'vault', 'profile', 'credentialIngress'])
      || !exact(value.state.broker, ['status', 'managed']) || !BROKER_STATES.has(value.state.broker.status)
      || typeof value.state.broker.managed !== 'boolean'
      || !exact(value.state.vault, ['status', 'verified']) || !VAULT_STATES.has(value.state.vault.status)
      || typeof value.state.vault.verified !== 'boolean'
      || !['available', 'unavailable'].includes(value.state.credentialIngress)
      || !plain(value.state.profile)) throw new Error('invalid_component_response');
  const profileKeys = value.state.profile.status === 'configured' ? ['status', 'provider'] : ['status'];
  if (!exact(value.state.profile, profileKeys) || !['configured', 'not_configured'].includes(value.state.profile.status)
      || value.state.profile.status === 'configured' && value.state.profile.provider !== target.provider) throw new Error('invalid_component_response');
  if (!exact(value.capabilities, ['credentialActions', 'authenticationTest'])
      || !Array.isArray(value.capabilities.credentialActions) || value.capabilities.credentialActions.length !== 4) throw new Error('invalid_component_response');
  const actions = ['keep', 'enroll', 'replace', 'remove'].map((id, index) => validateAction(value.capabilities.credentialActions[index], id));
  const authenticationTest = validateAction(value.capabilities.authenticationTest, 'run');
  if (!exact(value.defaults, ['credentialAction', 'startBroker', 'testAuthentication'])
      || !CREDENTIAL_ACTIONS.has(value.defaults.credentialAction) || value.defaults.credentialAction === 'auto'
      || typeof value.defaults.startBroker !== 'boolean' || typeof value.defaults.testAuthentication !== 'boolean') throw new Error('invalid_component_response');
  return {
    workflow: 'setup_auth', target,
    state: {
      broker: { status: value.state.broker.status, managed: value.state.broker.managed },
      vault: { status: value.state.vault.status, verified: value.state.vault.verified },
      profile: { status: value.state.profile.status, ...(value.state.profile.status === 'configured' ? { provider: value.state.profile.provider } : {}) },
      credentialIngress: value.state.credentialIngress,
    },
    capabilities: { credentialActions: actions, authenticationTest },
    defaults: { ...value.defaults },
  };
}

function validateRunInput(input) {
  exactObject(input, ['provider', 'profile', 'credentialAction', 'startBroker', 'testAuthentication', 'operationId']);
  const value = {
    provider: input.provider === undefined ? 'paycom' : input.provider,
    profile: input.profile === undefined ? 'paycom-main' : input.profile,
    credentialAction: input.credentialAction === undefined ? 'auto' : input.credentialAction,
    startBroker: input.startBroker === undefined ? true : input.startBroker,
    testAuthentication: input.testAuthentication === undefined ? false : input.testAuthentication,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
  };
  if (!SETUP_PROVIDERS.has(value.provider) || typeof value.profile !== 'string' || !PROFILE_RE.test(value.profile)
      || !CREDENTIAL_ACTIONS.has(value.credentialAction) || value.credentialAction === 'remove' && value.testAuthentication
      || typeof value.startBroker !== 'boolean' || typeof value.testAuthentication !== 'boolean'
      || value.operationId !== undefined && (typeof value.operationId !== 'string' || !OPERATION_RE.test(value.operationId))) invalid();
  return value;
}

function safeResult(value, kind) {
  if (!isResult(value)) return failure('invalid_component_response');
  if (!value.ok) {
    if (!PUBLIC_FAILURES.has(value.status)) return failure('invalid_component_response');
    if (value.data !== null && (!exact(value.data, ['workflow', 'profile', 'provider', 'nextActions', 'cause', 'state'])
        || value.data.workflow !== 'setup_auth' || !SETUP_PROVIDERS.has(value.data.provider)
        || !PROFILE_RE.test(value.data.profile) || !Array.isArray(value.data.nextActions)
        || value.data.nextActions.length > 8 || value.data.nextActions.some(item => typeof item !== 'string' || !STATUS_RE.test(item))
        || value.data.cause !== null && (typeof value.data.cause !== 'string' || !STATUS_RE.test(value.data.cause))
        || !exact(value.data.state, ['broker', 'profile', 'mutation', 'recovery'])
        || !['ready', 'stopped', 'unknown'].includes(value.data.state.broker)
        || !['configured', 'not_configured', 'unknown'].includes(value.data.state.profile)
        || !['none', 'enrolled', 'replaced', 'removed'].includes(value.data.state.mutation)
        || !['not_needed', 'restored', 'failed'].includes(value.data.state.recovery))) {
      return failure('invalid_component_response');
    }
    return failure(value.status, { recoverable: value.error.recoverable, data: value.data });
  }
  try {
    if (kind === 'prepare') {
      if (value.status !== 'ready') throw new Error('invalid_component_response');
      return success('ready', preparationData(value.data));
    }
    if (value.status !== 'complete' || !exact(value.data, ['workflow', 'provider', 'profile', 'configured', 'broker', 'vault', 'authenticationTest', 'nextActions'])
        || value.data.workflow !== 'setup_auth' || !SETUP_PROVIDERS.has(value.data.provider) || !PROFILE_RE.test(value.data.profile)
        || typeof value.data.configured !== 'boolean' || !['ready', 'stopped'].includes(value.data.broker) || value.data.vault !== 'verified'
        || !['skipped', 'authenticated'].includes(value.data.authenticationTest) || !Array.isArray(value.data.nextActions)
        || !value.data.configured && value.data.authenticationTest !== 'skipped'
        || value.data.nextActions.length > 8 || value.data.nextActions.some(item => typeof item !== 'string' || !STATUS_RE.test(item))) throw new Error('invalid_component_response');
    return success('complete', value.data);
  } catch { return failure('invalid_component_response'); }
}

class AuthSetupWorkflowClient {
  #port;

  constructor({ port } = {}) {
    if (!port || typeof port.prepare !== 'function' || typeof port.run !== 'function') throw new TypeError('auth_setup_port_required');
    this.#port = port;
  }

  async prepare(input = {}) {
    let value;
    try {
      exactObject(input, ['provider', 'profile']);
      value = await this.#port.prepare(input);
    } catch (error) {
      return failure(error?.code === 'invalid_input' ? 'invalid_input' : 'setup_auth_failed');
    }
    return safeResult(value, 'prepare');
  }

  async run(input = {}, { events = { emit() {} }, signal = null } = {}) {
    let values;
    try {
      values = validateRunInput(input);
      if (!events || typeof events.emit !== 'function') invalid();
    } catch { return failure('invalid_input'); }
    let value;
    try { value = await this.#port.run(values, { events, signal }); }
    catch { return failure('setup_auth_failed'); }
    return safeResult(value, 'run');
  }
}

module.exports = { AuthSetupWorkflowClient, validateRunInput, preparationData, safeResult };
