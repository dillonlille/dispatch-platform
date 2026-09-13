'use strict';

const { spawnSync } = require('node:child_process');
const { OCI_HOST_HELPER_PROTOCOL_VERSION } = require('./oci-host-helper');

const DEFAULT_OCI_HOST_HELPER = '/opt/dispatch-control/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-helper';
const MAX_HELPER_BYTES = 256 * 1024;

function fail(code = 'service_installation_failed') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function createOciHostHelperClient(options = {}) {
  if (!plain(options) || Object.keys(options).some(key => !['helper', 'sudo', 'execute', 'authorizeRequest', 'requestPort'].includes(key))) {
    fail('runtime_boundary_violation');
  }
  const helper = options.helper || DEFAULT_OCI_HOST_HELPER;
  const sudo = options.sudo || '/usr/bin/sudo';
  const execute = options.execute || spawnSync;
  const authorizeRequest = options.authorizeRequest;
  if (helper !== DEFAULT_OCI_HOST_HELPER || sudo !== '/usr/bin/sudo' || typeof execute !== 'function'
      || (typeof authorizeRequest !== 'function' && typeof options.requestPort !== 'function')) {
    fail('runtime_boundary_violation');
  }

  function rpc(operation, claim, payload = {}) {
    if (!plain(claim) || !plain(payload)) fail('runtime_boundary_violation');
    const request = { version: OCI_HOST_HELPER_PROTOCOL_VERSION, operation, claim, ...payload };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_HELPER_BYTES) fail('runtime_boundary_violation');
    if (options.requestPort) return options.requestPort(request);
    const authorization = authorizeRequest(request);
    if (typeof authorization !== 'string' || !/^[a-f0-9]{64}$/.test(authorization)) fail('runtime_boundary_violation');
    request.authorization = authorization;
    const input = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(input, 'utf8') > MAX_HELPER_BYTES) fail('runtime_boundary_violation');
    const result = execute(sudo, ['-n', helper], {
      input,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: MAX_HELPER_BYTES,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string'
        || !result.stdout.endsWith('\n') || result.stdout.slice(0, -1).includes('\n')
        || Buffer.byteLength(result.stdout, 'utf8') > MAX_HELPER_BYTES) fail();
    let response;
    try { response = JSON.parse(result.stdout.slice(0, -1)); } catch { fail(); }
    if (!plain(response) || typeof response.ok !== 'boolean') fail();
    if (!response.ok) fail(typeof response.status === 'string' ? response.status : 'service_installation_failed');
    if (Object.keys(response).sort().join(',') !== 'ok,result') fail();
    return response.result;
  }

  const hostRegistry = Object.freeze({
    reserve: (runtimeKey, claim) => rpc('reserve_account', claim, { runtimeKey }),
    inspect: (runtimeKey, claim) => rpc('inspect_account', claim, { runtimeKey }),
  });

  function mutate(operation, plan, claim, capability, payload = {}) {
    if (typeof capability !== 'function') fail('runtime_boundary_violation');
    return capability(() => rpc(operation, claim, { plan, ...payload }));
  }

  const hostExecutor = Object.freeze({
    prepareAccount: (plan, claim, capability) => mutate('prepare_account', plan, claim, capability),
    materializeLayout: (plan, token, claim, capability) =>
      mutate('materialize_layout', plan, claim, capability, { token }),
    prepareImage: (plan, claim, capability) => mutate('prepare_image', plan, claim, capability),
    render: (plan, claim, capability) => mutate('render', plan, claim, capability),
    validate: (plan, claim) => rpc('validate', claim, { plan }),
    install: (plan, claim, capability) => mutate('install', plan, claim, capability),
    start: (plan, claim, capability) => mutate('start', plan, claim, capability),
    stop: (plan, claim, capability) => mutate('stop', plan, claim, capability),
    disable: (plan, claim, capability) => mutate('disable', plan, claim, capability),
    inspect: (plan, claim) => rpc('inspect', claim, { plan }),
    inspectInactive: (plan, claim) => rpc('inspect_inactive', claim, { plan }),
    health: (plan, claim) => rpc('health', claim, { plan }),
    verifyPublication: (plan, payload, claim) => rpc('verify_publication', claim, { plan, payload }),
    commit: (plan, claim, capability) => mutate('commit', plan, claim, capability),
    settleCommitted: (plan, claim, capability) => mutate('settle_committed', plan, claim, capability),
    rollback: (plan, claim, capability) => mutate('rollback', plan, claim, capability),
    rollbackStopped: (plan, claim, capability) => mutate('rollback_stopped', plan, claim, capability),
    startPrior: (plan, claim, capability) => mutate('start_prior', plan, claim, capability),
    settleRollback: (plan, claim, capability) => mutate('settle_rollback', plan, claim, capability),
    removeServices: (plan, claim, capability) => mutate('remove_services', plan, claim, capability),
    inspectRemoved: (plan, claim) => rpc('inspect_removed', claim, { plan }),
    settleRemoved: (plan, claim, capability) => mutate('settle_removed', plan, claim, capability),
    destroyAccount: (plan, claim, capability) => mutate('destroy_account', plan, claim, capability),
    verifyDestroyed: (plan, claim) => rpc('verify_destroyed', claim, { plan }),
  });

  function createBackupManager(plan, claim) {
    const query = (operation, payload) => rpc(operation, claim, { plan, payload });
    const change = (operation, payload, capability) => {
      if (typeof capability !== 'function') fail('runtime_boundary_violation');
      return capability(() => query(operation, payload));
    };
    return Object.freeze({
      snapshot: (spec, capability) => change('backup_snapshot', { spec }, capability),
      inspect: spec => query('backup_inspect', { spec }),
      restore: (source, operationId, capability) =>
        change('backup_restore', { source, operationId }, capability),
      inspectRestored: source => query('backup_inspect_restored', { source }),
      destroy: (authority, capability) => change('backup_destroy', { authority }, capability),
      verifyDestroyed: () => query('backup_verify_destroyed', {}),
    });
  }

  return Object.freeze({ hostRegistry, hostExecutor, createBackupManager });
}

module.exports = { DEFAULT_OCI_HOST_HELPER, createOciHostHelperClient };
