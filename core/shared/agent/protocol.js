'use strict';

const { INSTALLATION_IDENTIFIER_RE } = require('../contracts/src/installation');
const { isResult } = require('../contracts/src/result');
const {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  RUNTIME_GATEWAY_ACTIONS,
  GATEWAY_FAILURES,
  validateGatewayRequest,
} = require('../gateway/protocol');

const RUNTIME_AGENT_PROTOCOL_VERSION = 1;
const REGISTRATION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const AUTHORITY_DIGEST_RE = /^[a-f0-9]{64}$/;
const REQUEST_ID_RE = /^[a-f0-9]{32}$/;
const LEGACY_RUNTIME_GATEWAY_ACTIONS = Object.freeze([
  'health', 'system.status', 'workforce.day', 'sync.status', 'sync.run_now',
]);
const AGENT_FAILURES = Object.freeze([
  'invalid_runtime_agent_frame',
  'runtime_agent_protocol_mismatch',
  'runtime_agent_unauthorized',
  'runtime_agent_conflict',
  'runtime_agent_unavailable',
]);
const AGENT_FAILURE_SET = new Set(AGENT_FAILURES);
const GATEWAY_FAILURE_SET = new Set(GATEWAY_FAILURES);

function fail(code = 'invalid_runtime_agent_frame') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
  return value;
}

function protocol(value) {
  if (value !== RUNTIME_AGENT_PROTOCOL_VERSION) fail('runtime_agent_protocol_mismatch');
}

function runtimeKey(value) {
  if (typeof value !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value)) fail();
  return value;
}

function requestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) fail();
  return value;
}

function heartbeatNonce(value) {
  return requestId(value);
}

function actions(value) {
  const current = Array.isArray(value) && value.length === RUNTIME_GATEWAY_ACTIONS.length
    && value.every((action, index) => action === RUNTIME_GATEWAY_ACTIONS[index]);
  const legacy = Array.isArray(value) && value.length === LEGACY_RUNTIME_GATEWAY_ACTIONS.length
    && value.every((action, index) => action === LEGACY_RUNTIME_GATEWAY_ACTIONS[index]);
  const previous = RUNTIME_GATEWAY_ACTIONS.filter(action => !['workforce.employees', 'workforce.employee', 'runtime.execution'].includes(action));
  const compatible = Array.isArray(value) && value.length === previous.length && value.every((action, index) => action === previous[index]);
  const beforeExecution = RUNTIME_GATEWAY_ACTIONS.filter(action => action !== 'runtime.execution');
  const rollingUpgrade = Array.isArray(value) && value.length === beforeExecution.length && value.every((action, index) => action === beforeExecution[index]);
  if (!current && !legacy && !compatible && !rollingUpgrade) fail();
  return Object.freeze([...value]);
}

function registrationToken(value) {
  if (typeof value !== 'string' || !REGISTRATION_TOKEN_RE.test(value)) fail();
  return value;
}

function authorityDigest(value) {
  if (typeof value !== 'string' || !AUTHORITY_DIGEST_RE.test(value)) fail();
  return value;
}

function validateRegistrationFrame(value) {
  exact(value, ['protocolVersion', 'type', 'runtimeKey', 'registrationToken', 'actions']);
  protocol(value.protocolVersion);
  if (value.type !== 'register') fail();
  return Object.freeze({
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'register',
    runtimeKey: runtimeKey(value.runtimeKey),
    registrationToken: registrationToken(value.registrationToken),
    actions: actions(value.actions),
  });
}

function registeredFrame() {
  return Object.freeze({ protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION, type: 'registered' });
}

function validateRegisteredFrame(value) {
  exact(value, ['protocolVersion', 'type']);
  protocol(value.protocolVersion);
  if (value.type !== 'registered') fail();
  return registeredFrame();
}

function rejectedFrame(code) {
  const status = AGENT_FAILURE_SET.has(code) ? code : 'runtime_agent_unavailable';
  return Object.freeze({ protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION, type: 'rejected', status });
}

function validateRejectedFrame(value) {
  exact(value, ['protocolVersion', 'type', 'status']);
  protocol(value.protocolVersion);
  if (value.type !== 'rejected' || !AGENT_FAILURE_SET.has(value.status)) fail();
  return Object.freeze({ ...value });
}

function heartbeatFrame(nonceValue) {
  return Object.freeze({
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'heartbeat',
    nonce: heartbeatNonce(nonceValue),
  });
}

function validateHeartbeatFrame(value) {
  exact(value, ['protocolVersion', 'type', 'nonce']);
  protocol(value.protocolVersion);
  if (value.type !== 'heartbeat') fail();
  return heartbeatFrame(value.nonce);
}

function heartbeatAckFrame(nonceValue) {
  return Object.freeze({
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'heartbeat_ack',
    nonce: heartbeatNonce(nonceValue),
  });
}

function validateHeartbeatAckFrame(value) {
  exact(value, ['protocolVersion', 'type', 'nonce']);
  protocol(value.protocolVersion);
  if (value.type !== 'heartbeat_ack') fail();
  return heartbeatAckFrame(value.nonce);
}

function requestFrame(requestIdValue, requestValue) {
  const selectedId = requestId(requestIdValue);
  validateGatewayRequest(requestValue);
  return Object.freeze({
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'request',
    requestId: selectedId,
    request: requestValue,
  });
}

function validateRequestFrame(value, expectedRuntimeKey) {
  exact(value, ['protocolVersion', 'type', 'requestId', 'request']);
  protocol(value.protocolVersion);
  if (value.type !== 'request') fail();
  validateGatewayRequest(value.request, expectedRuntimeKey);
  return Object.freeze({
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'request',
    requestId: requestId(value.requestId),
    request: value.request,
  });
}

function gatewayEnvelope(value) {
  exact(value, ['protocolVersion', 'ok', 'status', 'result']);
  if (value.protocolVersion !== RUNTIME_GATEWAY_PROTOCOL_VERSION || typeof value.ok !== 'boolean'
      || typeof value.status !== 'string') fail();
  if (value.ok) {
    if (value.status !== 'completed' || !isResult(value.result)) fail();
  } else if (!GATEWAY_FAILURE_SET.has(value.status) || value.result !== null) fail();
  return Object.freeze({ ...value });
}

function responseFrame(requestIdValue, responseValue) {
  return Object.freeze({
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'response',
    requestId: requestId(requestIdValue),
    response: gatewayEnvelope(responseValue),
  });
}

function validateResponseFrame(value) {
  exact(value, ['protocolVersion', 'type', 'requestId', 'response']);
  protocol(value.protocolVersion);
  if (value.type !== 'response') fail();
  return responseFrame(value.requestId, value.response);
}

module.exports = {
  RUNTIME_AGENT_PROTOCOL_VERSION,
  REGISTRATION_TOKEN_RE,
  AUTHORITY_DIGEST_RE,
  REQUEST_ID_RE,
  LEGACY_RUNTIME_GATEWAY_ACTIONS,
  AGENT_FAILURES,
  registrationToken,
  authorityDigest,
  validateRegistrationFrame,
  registeredFrame,
  validateRegisteredFrame,
  rejectedFrame,
  validateRejectedFrame,
  heartbeatFrame,
  validateHeartbeatFrame,
  heartbeatAckFrame,
  validateHeartbeatAckFrame,
  requestFrame,
  validateRequestFrame,
  responseFrame,
  validateResponseFrame,
};
