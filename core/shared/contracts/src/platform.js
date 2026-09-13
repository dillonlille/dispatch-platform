'use strict';

const { INSTALLATION_STATES, installationFailure } = require('./installation');

const PLATFORM_CONTROL_REFERENCE_RE = /^[A-Za-z0-9_-]{43}$/;
const PLATFORM_IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const PLATFORM_ORGANIZATION_STATES = Object.freeze(['pending_owner', 'setup_required', 'active', 'suspended']);
const PLATFORM_OWNER_STATES = Object.freeze(['missing', 'pending', 'active']);
const PLATFORM_INSTALLATION_OPERATION_KINDS = Object.freeze(['provision', 'retry', 'activation', 'decommission', 'destroy', 'restore_dsp', 'resume', 'suspend', 'restart', 'upgrade']);
const PLATFORM_INSTALLATION_OPERATION_STATES = Object.freeze([
  'pending', 'dispatched', 'completed', 'queued', 'running', 'succeeded', 'failed',
]);
const PLATFORM_INSTALLATION_ACTIONS = Object.freeze(['provision', 'retry_provision', 'decommission', 'destroy', 'restore_dsp', 'suspend', 'resume', 'restart']);
const PLATFORM_ORGANIZATION_ACTIONS = Object.freeze([
  'issue_owner_invitation', 'revoke_owner_invitation', 'suspend', 'resume',
]);
const ORGANIZATION_SETUP_STATES = Object.freeze([
  'waiting_for_platform', 'server_owner_required', 'owner_required', 'verification_in_progress', 'ready', 'unavailable',
]);

function fail() {
  throw Object.assign(new Error('invalid_platform_contract'), { code: 'invalid_platform_contract' });
}

function exactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail();
  return value;
}

function boundedText(value, { minimum = 1, maximum = 254, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || /[\0\r\n]/.test(value)) fail();
  return value;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
}

function closedChoice(value, choices) {
  if (typeof value !== 'string' || !choices.includes(value)) fail();
  return value;
}

function uniqueChoices(value, choices) {
  if (!Array.isArray(value) || value.length > choices.length || new Set(value).size !== value.length
      || value.some(item => !choices.includes(item))) fail();
  return Object.freeze([...value]);
}

function platformControlReference(value) {
  if (typeof value !== 'string' || !PLATFORM_CONTROL_REFERENCE_RE.test(value)) fail();
  return value;
}

function platformIdempotencyKey(value) {
  if (typeof value !== 'string' || !PLATFORM_IDEMPOTENCY_RE.test(value)) fail();
  return value;
}

function platformInstallationOperation(value) {
  if (value === null) return null;
  exactObject(value, ['kind', 'status'], ['kind', 'status']);
  const kind = closedChoice(value.kind, PLATFORM_INSTALLATION_OPERATION_KINDS);
  const status = closedChoice(value.status, PLATFORM_INSTALLATION_OPERATION_STATES);
  const allowedStatuses = kind === 'activation'
    ? ['running', 'succeeded', 'failed']
    : ['decommission', 'destroy', 'restore_dsp', 'resume', 'suspend', 'restart', 'upgrade'].includes(kind) ? ['queued', 'running', 'succeeded', 'failed']
      : ['pending', 'dispatched', 'completed', 'failed'];
  if (!allowedStatuses.includes(status)) fail();
  return Object.freeze({ kind, status });
}

function platformInstallationStatus(value) {
  exactObject(value, ['state', 'revision', 'operation', 'failure', 'availableActions'],
    ['state', 'revision', 'operation', 'failure', 'availableActions']);
  const state = closedChoice(value.state, INSTALLATION_STATES);
  const operation = platformInstallationOperation(value.operation);
  const failure = value.failure === null ? null : installationFailure(value.failure);
  if ((state === 'failed' || operation?.status === 'failed') !== (failure !== null)) fail();
  return Object.freeze({
    state,
    revision: positive(value.revision),
    operation,
    failure,
    availableActions: uniqueChoices(value.availableActions, PLATFORM_INSTALLATION_ACTIONS),
  });
}

function ownerInvitation(value) {
  if (value === null) return null;
  exactObject(value, ['email', 'expiresAt'], ['email', 'expiresAt']);
  boundedText(value.email, { maximum: 254 });
  boundedText(value.expiresAt, { maximum: 32 });
  let canonical;
  try { canonical = new Date(value.expiresAt).toISOString(); } catch { fail(); }
  if (canonical !== value.expiresAt) fail();
  return Object.freeze({ email: value.email, expiresAt: value.expiresAt });
}

function station(value) {
  exactObject(value, ['code', 'primary'], ['code', 'primary']);
  if (typeof value.code !== 'string' || !/^[A-Z0-9]{3,8}$/.test(value.code) || typeof value.primary !== 'boolean') fail();
  return Object.freeze({ code: value.code, primary: value.primary });
}

function platformOrganization(value) {
  exactObject(value, [
    'controlRef', 'continuityRef', 'name', 'abbreviation', 'timezone', 'stations', 'memberCount',
    'organizationStatus', 'ownerStatus', 'ownerInvitation', 'installation', 'availableActions', 'ownerEmail', 'detailsStatus',
  ], [
    'controlRef', 'continuityRef', 'name', 'abbreviation', 'timezone', 'stations', 'memberCount',
    'organizationStatus', 'ownerStatus', 'ownerInvitation', 'installation', 'availableActions',
  ]);
  if (!Array.isArray(value.stations) || value.stations.length < 1 || value.stations.length > 16
      || !Number.isSafeInteger(value.memberCount) || value.memberCount < 0) fail();
  const selectedOwner = closedChoice(value.ownerStatus, PLATFORM_OWNER_STATES);
  const invitation = ownerInvitation(value.ownerInvitation);
  if ((selectedOwner === 'pending') !== (invitation !== null)) fail();
  return Object.freeze({
    controlRef: platformControlReference(value.controlRef),
    continuityRef: platformControlReference(value.continuityRef),
    name: boundedText(value.name, { maximum: 120 }),
    abbreviation: boundedText(value.abbreviation, { minimum: 2, maximum: 16, nullable: true }),
    timezone: boundedText(value.timezone, { maximum: 64 }),
    stations: Object.freeze(value.stations.map(station)),
    memberCount: value.memberCount,
    organizationStatus: closedChoice(value.organizationStatus, PLATFORM_ORGANIZATION_STATES),
    ownerStatus: selectedOwner,
    ownerEmail: boundedText(value.ownerEmail ?? invitation?.email ?? null, { maximum: 254, nullable: true }),
    detailsStatus: closedChoice(value.detailsStatus || 'complete', ['required', 'submitted', 'complete']),
    ownerInvitation: invitation,
    installation: platformInstallationStatus(value.installation),
    availableActions: uniqueChoices(value.availableActions, PLATFORM_ORGANIZATION_ACTIONS),
  });
}

function platformInstallationReceipt(value) {
  exactObject(value, ['action', 'status', 'installationState', 'installationRevision', 'replayed'],
    ['action', 'status', 'installationState', 'installationRevision', 'replayed']);
  if (!PLATFORM_INSTALLATION_ACTIONS.includes(value.action)
      || !['accepted', 'replayed'].includes(value.status)
      || !INSTALLATION_STATES.includes(value.installationState)
      || typeof value.replayed !== 'boolean'
      || (value.status === 'replayed') !== value.replayed) fail();
  return Object.freeze({
    action: value.action,
    status: value.status,
    installationState: value.installationState,
    installationRevision: positive(value.installationRevision),
    replayed: value.replayed,
  });
}

function organizationSetupStatus(value) {
  exactObject(value, [
    'organization', 'organizationStatus', 'installationState', 'setupState', 'handoff',
    'operationalAccess', 'failure',
  ], [
    'organization', 'organizationStatus', 'installationState', 'setupState', 'handoff',
    'operationalAccess', 'failure',
  ]);
  exactObject(value.organization, ['name', 'abbreviation', 'stationCode', 'timezone'],
    ['name', 'abbreviation', 'stationCode', 'timezone']);
  if (!/^[A-Z0-9]{3,8}$/.test(value.organization.stationCode || '')) fail();
  const setupState = closedChoice(value.setupState, ORGANIZATION_SETUP_STATES);
  let handoff = null;
  if (value.handoff !== null) {
    exactObject(value.handoff, ['status', 'audience', 'channel'], ['status', 'audience', 'channel']);
    if (value.handoff.status !== 'required'
        || !(value.handoff.audience === 'server_owner' && value.handoff.channel === 'private_terminal'
          || value.handoff.audience === 'dsp_owner' && value.handoff.channel === 'dashboard')) fail();
    handoff = Object.freeze({ ...value.handoff });
  }
  if ((['server_owner_required', 'owner_required'].includes(setupState)) !== (handoff !== null)
      || !['available', 'unavailable'].includes(value.operationalAccess)) fail();
  const organizationStatus = closedChoice(value.organizationStatus, PLATFORM_ORGANIZATION_STATES);
  const installationState = closedChoice(value.installationState, INSTALLATION_STATES);
  const expectedSetupState = ['pending', 'provisioning', 'waiting_for_owner'].includes(installationState)
    ? 'waiting_for_platform'
    : installationState === 'waiting_for_provider_auth' ? (handoff?.channel === 'dashboard' ? 'owner_required' : 'server_owner_required')
      : installationState === 'verifying' ? 'verification_in_progress'
        : installationState === 'ready' ? 'ready' : 'unavailable';
  if (setupState !== expectedSetupState
      || (value.operationalAccess === 'available') !== (installationState === 'ready' && organizationStatus === 'active')) fail();
  const failure = value.failure === null ? null : installationFailure(value.failure);
  if ((installationState === 'failed') !== (failure !== null)) fail();
  return Object.freeze({
    organization: Object.freeze({
      name: boundedText(value.organization.name, { maximum: 120 }),
      abbreviation: boundedText(value.organization.abbreviation, { minimum: 2, maximum: 16, nullable: true }),
      stationCode: value.organization.stationCode,
      timezone: boundedText(value.organization.timezone, { maximum: 64 }),
    }),
    organizationStatus,
    installationState,
    setupState,
    handoff,
    operationalAccess: value.operationalAccess,
    failure,
  });
}

module.exports = {
  PLATFORM_CONTROL_REFERENCE_RE,
  PLATFORM_IDEMPOTENCY_RE,
  PLATFORM_ORGANIZATION_STATES,
  PLATFORM_OWNER_STATES,
  PLATFORM_INSTALLATION_OPERATION_KINDS,
  PLATFORM_INSTALLATION_OPERATION_STATES,
  PLATFORM_INSTALLATION_ACTIONS,
  PLATFORM_ORGANIZATION_ACTIONS,
  ORGANIZATION_SETUP_STATES,
  platformControlReference,
  platformIdempotencyKey,
  platformInstallationOperation,
  platformInstallationStatus,
  platformOrganization,
  platformInstallationReceipt,
  organizationSetupStatus,
};
