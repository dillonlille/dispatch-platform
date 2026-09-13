'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createOciHostAccountRegistry } = require('./oci-host-account-registry');
const { createOciHostExecutor } = require('./oci-host-executor');
const { validateOciDeploymentPlan } = require('./oci-deployment');
const { MANAGED_INSTALLATION_DIRECTORY_FIELDS } = require('../../../shared/paths/runtime-paths');
const { hostAccountName } = require('../../runtime-host-identity');
const { createOciHostAuthority } = require('./oci-host-authority');
const { readRootFile, verifyHostArtifact } = require('./oci-host-artifact');

const OCI_HOST_HELPER_PROTOCOL_VERSION = 2;
const OCI_HOST_HELPER_CONFIG = '/etc/dispatch/oci-host.json';
const CONTROL_RELEASE_ROOT = '/opt/dispatch-control/releases';
const OCI_HOST_HELPER_RELATIVE = 'host-helper-artifact/core/installations/bin/dispatch-oci-host-helper';
const OCI_TENANT_BACKUP_HELPER_RELATIVE = 'host-helper-artifact/core/installations/bin/dispatch-oci-tenant-backup-helper';
const OCI_HOST_HELPER_OPERATIONS = Object.freeze([
  'reserve_account',
  'inspect_account',
  'prepare_account',
  'materialize_layout',
  'prepare_image',
  'render',
  'validate',
  'install',
  'start',
  'stop',
  'disable',
  'inspect',
  'inspect_inactive',
  'health',
  'verify_publication',
  'commit',
  'settle_committed',
  'rollback',
  'rollback_stopped',
  'start_prior',
  'settle_rollback',
  'remove_services',
  'inspect_removed',
  'settle_removed',
  'destroy_account',
  'verify_destroyed',
  'backup_snapshot',
  'backup_inspect',
  'backup_restore',
  'backup_inspect_restored',
  'backup_destroy',
  'backup_verify_destroyed',
]);

function fail(code = 'service_installation_failed') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required = allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail('runtime_boundary_violation');
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail('runtime_boundary_violation');
  return value;
}

function claim(value) {
  exact(value, ['jobId', 'workerId', 'fence', 'generation'], ['jobId', 'workerId', 'fence']);
  if (![value.jobId, value.workerId].every(item => typeof item === 'string' && /^[a-z][a-z0-9_-]{2,95}$/.test(item))
      || !Number.isSafeInteger(value.fence) || value.fence < 1
      || Object.hasOwn(value, 'generation') && (!Number.isSafeInteger(value.generation) || value.generation < 1)) fail('runtime_boundary_violation');
  return value;
}

function loadConfig(file = OCI_HOST_HELPER_CONFIG) {
  const selected = absolute(file);
  let value;
  try { value = JSON.parse(readRootFile(selected, 0o600, 16 * 1024).toString('utf8')); } catch { fail('runtime_boundary_violation'); }
  exact(value, ['stateRoot', 'authorityRoot', 'unitRoot', 'releaseRoot', 'centralSocket', 'centralUid', 'controllerUid',
    'controlReleaseId', 'helperManifestSha256', 'authorityUid', 'helperCallerUid', 'helperCallerGid']);
  for (const key of ['authorityUid', 'helperCallerUid', 'helperCallerGid']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail('runtime_boundary_violation');
  }
  if (value.authorityUid === value.helperCallerUid) fail('runtime_boundary_violation');
  return Object.freeze({
    stateRoot: absolute(value.stateRoot),
    authorityRoot: absolute(value.authorityRoot),
    unitRoot: absolute(value.unitRoot),
    releaseRoot: absolute(value.releaseRoot),
    centralSocket: absolute(value.centralSocket),
    centralUid: value.centralUid,
    controllerUid: value.controllerUid,
    controlReleaseId: value.controlReleaseId,
    helperManifestSha256: value.helperManifestSha256,
    authorityUid: value.authorityUid,
    helperCallerUid: value.helperCallerUid,
    helperCallerGid: value.helperCallerGid,
  });
}

function identityAvailable(value, remainingMs) {
  for (const database of ['passwd', 'group']) {
    const result = spawnSync('/usr/bin/getent', [database, String(value)], {
      encoding: 'utf8', timeout: Math.min(5_000, remainingMs()), maxBuffer: 16 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    if (result.error || result.signal || ![0, 2].includes(result.status)) fail();
    if (result.status === 0) return false;
  }
  return true;
}

function namedIdentityOccupied(name, remainingMs) {
  for (const database of ['passwd', 'group']) {
    const result = spawnSync('/usr/bin/getent', [database, name], {
      encoding: 'utf8', timeout: Math.min(5_000, remainingMs()), maxBuffer: 16 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    if (result.error || result.signal || ![0, 2].includes(result.status)) fail();
    if (result.status === 0) return true;
  }
  return false;
}

function tenantLayout(plan) {
  return Object.freeze({
    installationRoot: plan.host.installationRoot,
    directories: Object.freeze(Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
      .map(([field, relative]) => [field, path.join(plan.host.installationRoot, relative)]))),
  });
}

function tenantBackup(plan, operation, payload, helperPath, timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 1) fail('runtime_boundary_violation');
  const helper = fs.lstatSync(helperPath);
  if (!helper.isFile() || helper.isSymbolicLink() || helper.uid !== 0 || helper.gid !== 0
      || helper.nlink !== 1 || (helper.mode & 0o7777) !== 0o555
      || fs.realpathSync(helperPath) !== helperPath) fail('runtime_boundary_violation');
  const request = `${JSON.stringify({ version: 1, operation, layout: tenantLayout(plan), payload })}\n`;
  if (Buffer.byteLength(request, 'utf8') > 128 * 1024) fail('runtime_boundary_violation');
  const result = spawnSync('/usr/sbin/runuser', [
    '--user', plan.account.name, '--', '/usr/bin/env', '-i',
    `HOME=${plan.host.tenantRoot}`, 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8',
    '/usr/bin/node', '--no-warnings', helperPath,
  ], { input: request, encoding: 'utf8', timeout: Math.min(600_000, timeout), maxBuffer: 256 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  if (result.error || result.signal || typeof result.stdout !== 'string' || !result.stdout.endsWith('\n')
      || result.stdout.slice(0, -1).includes('\n')) fail('backup_failed');
  let response;
  try { response = JSON.parse(result.stdout.slice(0, -1)); } catch { fail('backup_failed'); }
  if (!plain(response) || typeof response.ok !== 'boolean') fail('backup_failed');
  if (!response.ok) fail(typeof response.status === 'string' ? response.status : 'backup_failed');
  if (result.status !== 0 || Object.keys(response).sort().join(',') !== 'ok,result') fail('backup_failed');
  return response.result;
}

function createOciHostHelper(options = {}) {
  exact(options, ['configFile', 'clock'], []);
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0 || process.getegid() !== 0) {
    fail('runtime_boundary_violation');
  }
  const config = loadConfig(options.configFile === undefined ? OCI_HOST_HELPER_CONFIG : options.configFile);
  if (process.env.SUDO_UID !== String(config.helperCallerUid)) fail('runtime_boundary_violation');
  const runningHelper = fs.realpathSync(process.argv[1]);
  const relativeHelper = path.relative(CONTROL_RELEASE_ROOT, runningHelper);
  const segments = relativeHelper.split(path.sep);
  if (segments.length < 2 || !/^[a-z][a-z0-9_.-]{2,95}$/.test(segments[0])
      || segments.slice(1).join('/') !== OCI_HOST_HELPER_RELATIVE) fail('runtime_boundary_violation');
  const controlReleaseRoot = path.join(CONTROL_RELEASE_ROOT, segments[0]);
  verifyHostArtifact(runningHelper, config.controlReleaseId, config.helperManifestSha256);
  const tenantBackupHelper = path.join(controlReleaseRoot, OCI_TENANT_BACKUP_HELPER_RELATIVE);
  const clock = options.clock || Date.now;
  const authority = createOciHostAuthority({ root: config.authorityRoot, clock });
  let registry;
  let executor;
  let currentGuard;
  function initializeRegistry() {
    if (registry) return;
    registry = createOciHostAccountRegistry({
      stateRoot: config.stateRoot,
      identityAvailable: value => identityAvailable(value, currentGuard.remainingMs),
      clock: () => { currentGuard.remainingMs(); return clock(); },
    });
  }
  function initializeExecutor() {
    if (executor) return;
    initializeRegistry();
    executor = createOciHostExecutor({
      registry,
      stateRoot: config.stateRoot,
      unitRoot: config.unitRoot,
      releaseRoot: config.releaseRoot,
      centralSocket: config.centralSocket,
      centralUid: config.centralUid,
      controllerUid: config.controllerUid,
      clock,
      remainingMs: () => currentGuard.remainingMs(),
    });
  }

  function execute(requestValue) {
    exact(requestValue, ['version', 'operation', 'claim', 'authorization', 'runtimeKey', 'plan', 'token', 'payload'],
      ['version', 'operation', 'claim', 'authorization']);
    if (requestValue.version !== OCI_HOST_HELPER_PROTOCOL_VERSION
        || !OCI_HOST_HELPER_OPERATIONS.includes(requestValue.operation)) fail('runtime_boundary_violation');
    claim(requestValue.claim);
    return authority.execute(requestValue, mutate => executeAuthorized(requestValue, mutate));
  }

  function executeAuthorized(requestValue, mutate) {
    currentGuard = mutate;
    const operation = requestValue.operation;
    const accountOperation = ['reserve_account', 'inspect_account'].includes(operation);
    const expectedKeys = accountOperation ? 'authorization,claim,operation,runtimeKey,version'
      : operation === 'materialize_layout' ? 'authorization,claim,operation,plan,token,version'
        : (operation.startsWith('backup_') || operation === 'verify_publication') ? 'authorization,claim,operation,payload,plan,version'
          : 'authorization,claim,operation,plan,version';
    if (Object.keys(requestValue).sort().join(',') !== expectedKeys) fail('runtime_boundary_violation');
    if (!accountOperation) validateOciDeploymentPlan(requestValue.plan);
    mutate(accountOperation ? initializeRegistry : initializeExecutor);
    if (operation === 'reserve_account') {
      if (!registry.inspect(requestValue.runtimeKey)
          && namedIdentityOccupied(hostAccountName(requestValue.runtimeKey), mutate.remainingMs)) {
        fail('runtime_boundary_violation');
      }
      return mutate(() => registry.reserve(requestValue.runtimeKey));
    }
    if (operation === 'inspect_account') {
      return registry.inspect(requestValue.runtimeKey);
    }
    const backupOperations = Object.freeze({
      backup_snapshot: 'snapshot', backup_inspect: 'inspect', backup_restore: 'restore',
      backup_inspect_restored: 'inspect_restored', backup_destroy: 'destroy',
      backup_verify_destroyed: 'verify_destroyed',
    });
    const plan = validateOciDeploymentPlan(requestValue.plan);
    if (Object.hasOwn(backupOperations, operation)) {
      if (!plain(requestValue.payload)) fail('runtime_boundary_violation');
      if (operation === 'backup_destroy' || operation === 'backup_verify_destroyed') {
        exact(requestValue.payload, operation === 'backup_destroy' ? ['authority'] : []);
        if (operation === 'backup_destroy') {
          const approval = requestValue.payload.authority;
          exact(approval, ['installationState', 'retainedData', 'destructionApproved']);
          if (approval.installationState !== 'decommissioned' || approval.retainedData !== true
              || approval.destructionApproved !== true) fail('runtime_boundary_violation');
        }
        // A crash after tenant deletion must not require running a helper as an
        // account that no longer exists. The authorized action still binds this
        // exact destruction/absence check and the server-derived plan.
        try { fs.lstatSync(plan.host.installationRoot); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return Object.freeze({ status: operation === 'backup_destroy' ? 'destroyed' : 'absent', changed: false });
        }
      }
      return mutate(() => tenantBackup(plan, backupOperations[operation], requestValue.payload, tenantBackupHelper, mutate.remainingMs()));
    }
    const methods = Object.freeze({
      prepare_account: () => executor.prepareAccount(plan, mutate),
      materialize_layout: () => executor.materializeLayout(plan, requestValue.token, mutate),
      prepare_image: () => executor.prepareImage(plan, mutate),
      render: () => executor.render(plan, mutate),
      validate: () => executor.validate(plan),
      install: () => executor.install(plan, mutate),
      start: () => executor.start(plan, mutate),
      stop: () => executor.stop(plan, mutate),
      disable: () => executor.disable(plan, mutate),
      inspect: () => executor.inspect(plan),
      inspect_inactive: () => executor.inspectState(plan, false),
      health: () => executor.health(plan),
      verify_publication: () => executor.verifyPublication(plan, requestValue.payload, mutate),
      commit: () => executor.commit(plan, mutate),
      settle_committed: () => executor.settleCommitted(plan, mutate),
      rollback: () => executor.rollback(plan, mutate),
      rollback_stopped: () => executor.rollbackStopped(plan, mutate),
      start_prior: () => executor.startPrior(plan, mutate),
      settle_rollback: () => executor.settleRollback(plan, mutate),
      remove_services: () => executor.removeServices(plan, mutate),
      inspect_removed: () => executor.inspectRemoved(plan),
      settle_removed: () => executor.settleRemoved(plan, mutate),
      destroy_account: () => executor.destroyAccount(plan, mutate),
      verify_destroyed: () => executor.verifyDestroyed(plan),
    });
    const selected = methods[operation];
    if (!selected) fail('runtime_boundary_violation');
    return selected();
  }

  function close() { try { registry?.close(); } finally { authority.close(); } }
  return Object.freeze({ execute, close });
}

module.exports = {
  OCI_HOST_HELPER_PROTOCOL_VERSION,
  OCI_HOST_HELPER_CONFIG,
  CONTROL_RELEASE_ROOT,
  OCI_HOST_HELPER_RELATIVE,
  OCI_TENANT_BACKUP_HELPER_RELATIVE,
  OCI_HOST_HELPER_OPERATIONS,
  loadConfig,
  createOciHostHelper,
};
