'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { success, failure } = require('dispatch-protocol/contracts/src/result');
const { setupRequest, paycomReadiness } = require('dispatch-protocol/contracts/src/paycom-setup');
const { request: brokerRequest } = require('dispatch-runtime-kit/auth-broker/src/client');
const { ensurePrivateDirectory } = require('../auth-broker/src/vault');
const { managedInstallationRuntimeEnvironment } = require('dispatch-protocol/paths/runtime-paths');
const { createManagedPaycomActivationRuntime } = require('./paycom-activation');
const { managedPaycomDefinition, managedPaycomFirstPublicationRequest } = require('./paycom-definition');
const { LocalCollectionAdminPort } = require('../adapters/local/collection-admin-port');
const { createFrameworkClient } = require('dispatch-sdk/runtime');
const { configuration, assertMountBoundary } = require('../supervisor/src/supervisor');

function fail(code = 'runtime_boundary_violation') { throw Object.assign(new Error(code), { code }); }
const SAFE_ERRORS = new Set(['provider_auth_required', 'first_publication_failed', 'runtime_health_failed',
  'profile_exists', 'profile_not_configured', 'invalid_input', 'setup_interrupted', 'setup_busy',
  'mfa_required', 'captcha_required', 'account_locked', 'invalid_credentials', 'primary_credentials_rejected',
  'security_answers_rejected', 'manual_verification_required', 'attempt_cooldown', 'profile_locked']);
function errorCode(error) { return SAFE_ERRORS.has(error?.code) ? error.code : 'runtime_boundary_violation'; }

function createContainerPaycomSetup(config, client) {
  const root = require('dispatch-protocol/paths/feature-paths').featurePaths(config.paths, 'paycom').stateRoot;
  // Fresh DSPs have no feature state yet. Validate/create each private level
  // rather than bypassing the storage boundary with recursive directory creation.
  ensurePrivateDirectory(path.dirname(root));
  ensurePrivateDirectory(root);
  const running = new Map();
  function file(key) { return path.join(root, `${key}.json`); }
  function read(key) {
    ensurePrivateDirectory(root);
    let info;
    try { info = fs.lstatSync(file(key)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.geteuid()
        || (info.mode & 0o7777) !== 0o600 || info.size > 128 * 1024) fail();
    const value = JSON.parse(fs.readFileSync(file(key), 'utf8'));
    if (!value || !['running', 'succeeded', 'failed'].includes(value.status)
        || Object.keys(value).sort().join(',') !== 'data,error,status') fail();
    return value;
  }
  function write(key, value) {
    read(key);
    if (fs.readdirSync(root).length > 256) fail();
    const candidate = `${file(key)}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(candidate, file(key));
    const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  function runtime(input) {
    const environment = managedInstallationRuntimeEnvironment(config.layout);
    return createManagedPaycomActivationRuntime({
      manifest: input.manifest, manifestAuthority: input.manifestAuthority, client,
      projectRoot: '/opt/dispatch',
      gateway: { health: async () => success('ready', { runtimeIdentity: 'matched' }) },
      collectionAdmin: new LocalCollectionAdminPort({ paths: config.paths.collection }),
      evidenceVerifier: { verify: request => createFrameworkClient().request('plugin.evidence', { pluginId: 'paycom', request }) },
      infrastructureVerifier: async manifest => {
        assertMountBoundary(configuration());
        const [auth, manager] = await Promise.all([client.auth.health(), client.collections.health()]);
        if (!auth.ok || auth.data?.vault?.verified !== true || !manager.ok
            || manager.data?.manager?.running !== true || manager.data?.databaseIntegrity !== 'ok') fail('runtime_health_failed');
        return { runtimeKey: manifest.runtime.key, runtime_layout: true, service_supervision: true,
          auth_broker: true, collection_manager: true, runtime_gateway: true };
      },
    });
  }
  async function execute(input) {
    if (input.command === 'enroll') {
      if (input.expiresAt < Date.now() || input.expiresAt > Date.now() + 60_000) fail('invalid_input');
      let result = await brokerRequest(config.paths.auth.socket, {
        action: 'enroll-paycom', credentials: input.credentials, intent: input.intent,
      });
      // A failed first delivery may leave nothing to replace. Only the broker's
      // explicit missing-profile response permits saving these credentials anew.
      if (!result.ok && result.status === 'profile_not_configured' && input.intent === 'replace') {
        result = await brokerRequest(config.paths.auth.socket, {
          action: 'enroll-paycom', credentials: input.credentials, intent: 'create',
        });
      }
      if (!result.ok) fail(result.status);
      return { configured: true };
    }
    const selected = runtime(input);
    if (input.step === 'test') return selected.testProvider('paycom-main');
    await selected.verifyInfrastructure(input.manifest);
    if (input.step === 'sync') return selected.startWorkforceSync();
    if (input.step === 'configure') return selected.configure(managedPaycomDefinition(input.manifest, input.manifestAuthority, { projectRoot: '/opt/dispatch' }));
    if (input.step === 'publish') return selected.publishFirst(managedPaycomFirstPublicationRequest(), {
      idempotencyKey: `activation:${input.parameters.jobId}`, heartbeat: async () => {},
    });
    if (input.step === 'verify') return selected.verifyPublication(input.parameters.batchId, input.parameters.preparationRunId);
    fail('invalid_input');
  }
  const handle = async value => {
    try {
      const input = setupRequest(value, config.runtimeKey);
      if (input.step === 'readiness') {
        // Always read the broker's current guard, never a cached setup receipt.
        const response = await brokerRequest(config.paths.auth.socket, { action: 'profile-readiness', profile: 'paycom-main' });
        if (!response.ok || response.status !== 'found') fail('runtime_health_failed');
        return success('succeeded', paycomReadiness(response.readiness));
      }
      if (input.step === 'infrastructure') return success('succeeded', await runtime(input).verifyInfrastructure(input.manifest));
      const enrollment = input.command === 'enroll';
      const identity = enrollment ? { requestId: input.requestId, intent: input.intent }
        : { requestId: input.requestId, step: input.step, manifest: input.manifest, parameters: input.parameters };
      const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      let saved = read(key);
      if (saved?.status === 'running' && !running.has(key)) {
        saved = { status: 'failed', data: null, error: 'setup_interrupted' }; write(key, saved);
      }
      if (!saved && input.command === 'status') return success('not_started', null);
      if (!saved) {
        if (running.size) return failure('setup_busy');
        saved = { status: 'running', data: null, error: null }; write(key, saved);
        const work = Promise.resolve().then(() => execute(input)).then(
          data => write(key, { status: 'succeeded', data, error: null }),
          error => write(key, { status: 'failed', data: null, error: errorCode(error) }),
        ).finally(() => running.delete(key));
        running.set(key, work);
        // Enrollment is short and never survives in the control-plane database.
        if (enrollment) { await work; saved = read(key); }
        else work.catch(() => {});
      }
      return saved.status === 'failed' ? failure(saved.error) : success(saved.status, saved.data);
    } catch (error) { return failure(errorCode(error)); }
  };
  handle.busy = () => running.size > 0;
  return handle;
}
module.exports = { createSetup: createContainerPaycomSetup };
