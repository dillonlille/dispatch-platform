'use strict';

const { INSTALLATION_IDENTIFIER_RE } = require('../contracts/src/installation');
const { isResult } = require('../contracts/src/result');
const { identifier } = require('../contracts/src/input');
const { workforceDayQuery, workforceQuery, workforceEmployeeCode } = require('../contracts/src/workforce');
const { syncRunOptions, syncStopOptions } = require('../contracts/src/sync');

const RUNTIME_GATEWAY_PROTOCOL_VERSION = 1;
const RUNTIME_GATEWAY_ACTIONS = Object.freeze([
  'runtime.execution',
  'plugins.manage',
  'plugins.invoke',
  'paycom.setup',
  'connections.manage',
  'diagnostics.seed',
  'health',
  'system.status',
  'workforce.day',
  'workforce.employees',
  'workforce.employee',
  'sync.status',
  'sync.run_now',
  'sync.start',
  'sync.stop',
  'collections.health',
]);
const ACTIONS = new Set(RUNTIME_GATEWAY_ACTIONS);
const GATEWAY_FAILURES = Object.freeze([
  'invalid_request',
  'runtime_identity_mismatch',
  'runtime_protocol_mismatch',
  'runtime_gateway_unavailable',
]);
const FAILURES = new Set(GATEWAY_FAILURES);

function fail(code = 'invalid_request') {
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

function runtimeKey(value, code = 'invalid_request') {
  if (typeof value !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value)) fail(code);
  return value;
}

function validateActionInput(action, input) {
  if (!ACTIONS.has(action)) fail();
  if (action === 'runtime.execution') {
    exact(input, ['command', 'scheduledAt']);
    if (!['adopt', 'tick', 'drain', 'resume', 'snapshot', 'restore'].includes(input.command)
        || input.scheduledAt !== null && (!Number.isSafeInteger(input.scheduledAt) || input.scheduledAt < 0)) fail();
    return Object.freeze({ ...input });
  }
  if (action === 'plugins.invoke') return require('../plugin-sdk/contract').pluginInvocation(input);
  if (action === 'plugins.manage') return require('../plugin-sdk/contract').pluginRequest(input);
  if (action === 'paycom.setup') return input;
  if (action === 'connections.manage') return require('../contracts/src/connections').connectionRequest(input);
  if (action === 'diagnostics.seed') {
    exact(input, ['requestId']);
    if (typeof input.requestId !== 'string' || !/^org_[a-f0-9]{32}$/.test(input.requestId)) fail();
    return Object.freeze({ requestId: input.requestId });
  }
  if (action === 'health' || action === 'system.status') {
    exact(input, []);
    return Object.freeze({});
  }
  if (action === 'workforce.day') {
    exact(input, ['query']);
    return Object.freeze({ query: Object.freeze(workforceDayQuery(input.query)) });
  }
  if (action === 'workforce.employees') {
    exact(input, ['query']);
    return Object.freeze({ query: Object.freeze(workforceQuery(input.query)) });
  }
  if (action === 'workforce.employee') {
    exact(input, ['code']);
    return Object.freeze({ code: workforceEmployeeCode(input.code) });
  }
  if (action === 'sync.status') {
    exact(input, ['id']);
    try { identifier(input.id); } catch { fail(); }
    return Object.freeze({ id: input.id });
  }
  if (action === 'sync.run_now') {
    exact(input, ['id', 'options']);
    let options;
    try { identifier(input.id); options = syncRunOptions(input.options); } catch { fail(); }
    return Object.freeze({ id: input.id, options: Object.freeze(options) });
  }
  if (action === 'sync.start') {
    exact(input, ['id']);
    try { identifier(input.id); } catch { fail(); }
    return Object.freeze({ id: input.id });
  }
  if (action === 'sync.stop') {
    exact(input, ['id', 'options']);
    let options;
    try { identifier(input.id); options = syncStopOptions(input.options); } catch { fail(); }
    return Object.freeze({ id: input.id, options: Object.freeze(options) });
  }
  if (action === 'collections.health') {
    exact(input, []);
    return Object.freeze({});
  }
  return fail();
}

function validateGatewayRequest(value, expectedRuntimeKey = null) {
  exact(value, ['protocolVersion', 'runtimeKey', 'action', 'input']);
  if (value.protocolVersion !== RUNTIME_GATEWAY_PROTOCOL_VERSION) fail('runtime_protocol_mismatch');
  const selectedRuntimeKey = runtimeKey(value.runtimeKey);
  if (expectedRuntimeKey !== null && selectedRuntimeKey !== runtimeKey(expectedRuntimeKey, 'runtime_identity_mismatch')) {
    fail('runtime_identity_mismatch');
  }
  if (typeof value.action !== 'string') fail();
  return Object.freeze({
    protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
    runtimeKey: selectedRuntimeKey,
    action: value.action,
    input: value.action === 'paycom.setup'
      ? require('../contracts/src/paycom-setup').setupRequest(value.input, selectedRuntimeKey)
      : validateActionInput(value.action, value.input),
  });
}

function gatewaySuccess(result) {
  if (!isResult(result)) fail('runtime_gateway_unavailable');
  return Object.freeze({
    protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
    ok: true,
    status: 'completed',
    result,
  });
}

function gatewayFailure(code) {
  const selected = FAILURES.has(code) ? code : 'runtime_gateway_unavailable';
  return Object.freeze({
    protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
    ok: false,
    status: selected,
    result: null,
  });
}

function validateGatewayResponse(value) {
  exact(value, ['protocolVersion', 'ok', 'status', 'result']);
  if (value.protocolVersion !== RUNTIME_GATEWAY_PROTOCOL_VERSION) fail('runtime_protocol_mismatch');
  if (typeof value.ok !== 'boolean' || typeof value.status !== 'string') fail('runtime_gateway_unavailable');
  if (!value.ok) {
    if (!FAILURES.has(value.status) || value.result !== null) fail('runtime_gateway_unavailable');
    fail(value.status);
  }
  if (value.status !== 'completed' || !isResult(value.result)) fail('runtime_gateway_unavailable');
  return value.result;
}

module.exports = {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  RUNTIME_GATEWAY_ACTIONS,
  GATEWAY_FAILURES,
  validateActionInput,
  validateGatewayRequest,
  validateGatewayResponse,
  gatewaySuccess,
  gatewayFailure,
};
