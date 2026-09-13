'use strict';

const {
  OCI_DEPLOYMENT_PLAN_VERSION,
  OCI_BACKEND,
  createOciDeploymentPlan,
  createOciFixtureDeploymentPlan,
} = require('./oci-deployment');

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required = allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail();
}

function createOciContainerAdapter(options) {
  exact(options, ['hostRegistry', 'hostExecutor', 'releaseResolver', 'credentialPort']);
  const { hostRegistry, hostExecutor, releaseResolver, credentialPort } = options;
  if (!hostRegistry || ['reserve', 'inspect'].some(method => typeof hostRegistry[method] !== 'function')
      || !hostExecutor || [
        'prepareAccount', 'materializeLayout', 'prepareImage', 'render', 'validate', 'install',
        'start', 'health', 'commit', 'rollback',
      ].some(method => typeof hostExecutor[method] !== 'function')
      || typeof releaseResolver !== 'function'
      || !credentialPort || typeof credentialPort.read !== 'function') fail();

  function fixtureOption(value) {
    exact(value, ['fixture', 'claim']);
    if (typeof value.fixture !== 'boolean' || !plain(value.claim)) fail();
    return value;
  }

  function receipt(status, changed = false) {
    return Object.freeze({
      ociDeploymentPlanVersion: OCI_DEPLOYMENT_PLAN_VERSION,
      status,
      changed: Boolean(changed),
    });
  }

  function plan(manifest, manifestAuthority, optionsValue, destroying = false, withState = false) {
    const options = fixtureOption(optionsValue);
    const account = hostRegistry.inspect(manifest?.runtime?.key, options.claim);
    if (!account || !['reserved', 'active', ...(destroying ? ['retired'] : [])].includes(account.status)) fail('service_installation_failed');
    const release = releaseResolver(manifest.runtime.releaseId, options.fixture);
    const deployment = Object.freeze({
      version: 1,
      backend: release.backend,
      channel: options.fixture ? 'fixture' : 'production',
      organizationId: manifest.organization.id,
      runtimeKey: manifest.runtime.key,
      manifestRevision: manifest.revision,
      releaseId: manifest.runtime.releaseId,
    });
    const create = options.fixture ? createOciFixtureDeploymentPlan : createOciDeploymentPlan;
    const selected = create(manifest, manifestAuthority, release, {
      name: account.name,
      uid: account.uid,
      gid: account.gid,
      subuidStart: account.subuidStart,
      subgidStart: account.subgidStart,
      subidCount: account.subidCount,
    }, deployment);
    return withState ? Object.freeze({ plan: selected, retired: account.status === 'retired' }) : selected;
  }

  function reconcileHostAccount(manifest, manifestAuthority, optionsValue, mutationCapability) {
    exact(optionsValue, ['fixture', 'claim']);
    if (typeof optionsValue.fixture !== 'boolean' || !plain(optionsValue.claim)) fail();
    let account;
    mutationCapability(() => { account = hostRegistry.reserve(manifest.runtime.key, optionsValue.claim); });
    if (!account) fail('service_installation_failed');
    const selected = plan(manifest, manifestAuthority, {
      fixture: optionsValue.fixture, claim: optionsValue.claim,
    });
    const accountReceipt = hostExecutor.prepareAccount(selected, optionsValue.claim, mutationCapability);
    const token = credentialPort.read(selected.runtimeKey);
    const layoutReceipt = hostExecutor.materializeLayout(selected, token, optionsValue.claim, mutationCapability);
    return receipt('host_account_ready', accountReceipt.changed || layoutReceipt.changed);
  }

  function reconcileImage(planValue, claim, mutationCapability) {
    if (!plain(claim)) fail();
    const selected = hostExecutor.prepareImage(planValue, claim, mutationCapability);
    return receipt('image_ready', selected.changed);
  }

  function reconcileBridge(planValue, claim, mutationCapability) {
    if (!plain(claim)) fail();
    const rendered = hostExecutor.render(planValue, claim, mutationCapability);
    hostExecutor.validate(planValue, claim);
    const installed = hostExecutor.install(planValue, claim, mutationCapability);
    return receipt('bridge_ready', rendered.changed || installed.changed);
  }

  function reconcileContainer(planValue, claim, mutationCapability) {
    if (!plain(claim)) fail();
    const selected = hostExecutor.start(planValue, claim, mutationCapability);
    return receipt('container_ready', selected.changed);
  }

  function verify(planValue, claim) {
    if (!plain(claim)) fail();
    hostExecutor.health(planValue, claim);
    return receipt('healthy');
  }

  function commit(planValue, claim, mutationCapability) {
    if (!plain(claim)) fail();
    return hostExecutor.commit(planValue, claim, mutationCapability);
  }

  function rollback(manifest, manifestAuthority, optionsValue, mutationCapability) {
    exact(optionsValue, ['fixture', 'intent', 'claim']);
    if (typeof optionsValue.fixture !== 'boolean' || !['failed', 'cancelled'].includes(optionsValue.intent)
        || !plain(optionsValue.claim)) fail();
    const account = hostRegistry.inspect(manifest.runtime.key, optionsValue.claim);
    if (!account) return receipt('rolled_back');
    const selected = plan(manifest, manifestAuthority, {
      fixture: optionsValue.fixture, claim: optionsValue.claim,
    });
    const rolledBack = hostExecutor.rollback(selected, optionsValue.claim, mutationCapability);
    return receipt('rolled_back', rolledBack.changed);
  }

  return Object.freeze({
    inspectUnallocated(manifest, manifestAuthority, optionsValue) {
      const options = fixtureOption(optionsValue);
      require('../../../shared/contracts/src').serverInstallationManifest(manifest, manifestAuthority);
      return hostRegistry.inspect(manifest.runtime.key, options.claim) === null;
    },
    plan: (manifest, authority, options) => plan(manifest, authority, options),
    destructionPlan: (manifest, authority, options) => plan(manifest, authority, options, true),
    destructionContext: (manifest, authority, options) => plan(manifest, authority, options, true, true),
    reconcileHostAccount,
    reconcileImage,
    reconcileBridge,
    reconcileContainer,
    verify,
    commit,
    rollback,
  });
}

module.exports = { createOciContainerAdapter };
