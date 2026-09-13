'use strict';

const crypto = require('node:crypto');
const { INSTALLATION_IDENTIFIER_RE } = require('../shared/contracts/src/installation');

const HOST_TENANT_ROOT = '/var/lib/dispatch/tenants';
const HOST_BRIDGE_ROOT = '/run/dispatch-runtime-agents';

function fail() {
  throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' });
}

function runtimeKey(value) {
  if (typeof value !== 'string' || value === 'local' || !INSTALLATION_IDENTIFIER_RE.test(value)) fail();
  return value;
}

function opaqueRuntimeSuffix(value) {
  return crypto.createHash('sha256').update(runtimeKey(value), 'utf8').digest('hex').slice(0, 20);
}

function hostAccountName(value) {
  return `dsp-${opaqueRuntimeSuffix(value)}`;
}

module.exports = {
  HOST_TENANT_ROOT,
  HOST_BRIDGE_ROOT,
  runtimeKey,
  opaqueRuntimeSuffix,
  hostAccountName,
};
