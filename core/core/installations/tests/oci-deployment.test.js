'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { INSTALLATION_MANIFEST_VERSION } = require('../../../shared/contracts/src');
const {
  OCI_DEPLOYMENT_PLAN_VERSION,
  OCI_BACKEND,
  SUBID_COUNT,
  hostAccountName,
  createOciDeploymentPlan,
  createOciFixtureDeploymentPlan,
  validateOciDeploymentPlan,
  podmanArguments,
  renderOciSystemUnit,
  renderOciBridgeSystemUnit,
} = require('../src/oci-deployment');

function inputs() {
  const runtimeKey = 'runtime_oci_alpha';
  const manifest = {
    manifestVersion: INSTALLATION_MANIFEST_VERSION,
    revision: 7,
    organization: { id: 'organization_alpha', stationCode: 'DXX1', timezone: 'America/Chicago' },
    runtime: { key: runtimeKey, templateId: 'isolated_dsp_v1', releaseId: 'dispatch-runtime-v1.0.0' },
  };
  const authority = {
    revision: manifest.revision,
    organization: { ...manifest.organization },
    runtime: { ...manifest.runtime },
  };
  const release = {
    version: 2,
    backend: OCI_BACKEND,
    releaseId: manifest.runtime.releaseId,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageId: 'f'.repeat(64),
    channel: 'production',
    image: `ghcr.io/example-organization/dispatch-runtime@sha256:${'a'.repeat(64)}`,
    sourceCommit: 'b'.repeat(40),
    platform: 'linux/amd64',
    runtimeAgentProtocol: 1,
    runtimeGatewayProtocol: 1,
    embeddedManifestSha256: 'c'.repeat(64),
    imageArchiveSha256: 'd'.repeat(64),
    bridgeManifestSha256: 'e'.repeat(64),
  };
  const account = {
    name: hostAccountName(runtimeKey),
    uid: 951,
    gid: 951,
    subuidStart: 300_000,
    subgidStart: 400_000,
    subidCount: SUBID_COUNT,
  };
  const deployment = {
    version: 1,
    backend: OCI_BACKEND,
    channel: 'production',
    organizationId: manifest.organization.id,
    runtimeKey,
    manifestRevision: manifest.revision,
    releaseId: manifest.runtime.releaseId,
  };
  return { manifest, authority, release, account, deployment };
}

test('OCI plan derives one closed non-root container from server-bound authority', () => {
  const values = inputs();
  const plan = createOciDeploymentPlan(values.manifest, values.authority, values.release, values.account, values.deployment);
  assert.equal(plan.version, OCI_DEPLOYMENT_PLAN_VERSION);
  assert.equal(plan.backend, OCI_BACKEND);
  assert.equal(plan.runtimeKey, values.manifest.runtime.key);
  assert.equal(plan.deployment.runtimeKey, values.manifest.runtime.key);
  assert.equal(plan.identity.containerName.startsWith('dispatch-dsp-'), true);
  assert.equal(plan.identity.unitName.endsWith('.service'), true);
  assert.equal(plan.host.installationRoot.endsWith(`/runtime/${plan.runtimeKey}`), true);
  assert.equal(plan.guest.installationRoot, `/var/lib/dispatch/${plan.runtimeKey}`);
  assert.equal(plan.security.readOnlyRoot, true);
  assert.equal(plan.security.engineSocketMounted, false);
  assert.deepEqual(plan.security.capabilities, ['SYS_CHROOT']);
  assert.equal(Object.hasOwn(plan.guest.environment, 'DISPATCH_LOCAL_ROOT'), false);
  assert.equal(Object.hasOwn(plan.guest.environment, 'DISPATCH_ACCESS_CONTROL_DATABASE_ROOT'), false);

  const args = podmanArguments(plan);
  assert.equal(args.at(-1), values.release.image);
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args.includes('--http-proxy=false'), true);
  assert.equal(args.includes('--pid=private'), true);
  assert.equal(args.includes('--ipc=private'), true);
  assert.equal(args.includes('--uts=private'), true);
  assert.equal(args.includes('ALL'), true);
  assert.equal(args.includes('SYS_CHROOT'), true);
  assert.equal(args.includes('no-new-privileges'), true);
  assert.equal(args.some(value => value === '-p' || value === '--publish' || value.startsWith('--publish=')), false);
  assert.equal(args.some(value => value.includes('/private-host-home') || value.includes('podman.sock')), false);
  assert.equal(args.filter(value => value === '--volume').length, 2);
  assert.equal(args.filter(value => value === '--env').length, Object.keys(plan.guest.environment).length);

  const unit = renderOciSystemUnit(plan);
  assert.match(unit, new RegExp(`User=${plan.account.name}`));
  assert.match(unit, /MemoryMax=4G/);
  assert.match(unit, /CPUQuota=200%/);
  assert.match(unit, /TasksMax=512/);
  assert.match(unit, /Slice=dispatch-dsp\.slice/);
  assert.match(unit, /--pull=never/);
  assert.match(unit, /--network=pasta/);
  assert.match(unit, /UnsetEnvironment=.*HTTP_PROXY.*http_proxy/);
  assert.doesNotMatch(unit, /latest|docker\.sock|podman\.sock|DISPATCH_LOCAL_ROOT=/);
  const bridge = renderOciBridgeSystemUnit(plan, {
    bridgeExecutable: '/opt/dispatch/runtime-agent-bridge/releases/test/service-cli.js',
    centralSocket: '/run/user/1000/dispatch/runtime-agent-hub.sock',
    centralUid: 1000,
    controllerUid: 0,
  });
  assert.match(bridge, /User=0/);
  assert.match(bridge, new RegExp(`DISPATCH_RUNTIME_BRIDGE_TENANT_UID=${plan.account.uid}`));
  assert.match(bridge, /RestrictAddressFamilies=AF_UNIX/);
  assert.doesNotMatch(bridge, /podman|docker|ExecStart=.*\.\.\//);
});

test('OCI plan rejects crossed releases, forged plans, arbitrary fields, and account identities', () => {
  const values = inputs();
  const wrongTemplate = {
    ...values.manifest,
    runtime: { ...values.manifest.runtime, templateId: 'systemd_user_v1' },
  };
  assert.throws(() => createOciDeploymentPlan(
    wrongTemplate,
    { ...values.authority, runtime: { ...wrongTemplate.runtime } },
    values.release,
    values.account,
    values.deployment,
  ), error => error.code === 'runtime_boundary_violation');
  assert.throws(() => createOciDeploymentPlan(values.manifest, values.authority, values.release, values.account),
    error => error.code === 'runtime_boundary_violation');
  assert.throws(() => createOciDeploymentPlan(values.manifest, values.authority, values.release, values.account, {
    ...values.deployment, organizationId: 'organization_crossed',
  }), error => error.code === 'runtime_identity_mismatch');
  assert.throws(() => createOciDeploymentPlan(values.manifest, values.authority, {
    ...values.release, releaseId: 'dispatch-runtime-v2.0.0',
  }, values.account, values.deployment), error => error.code === 'runtime_identity_mismatch');
  assert.throws(() => createOciDeploymentPlan(values.manifest, values.authority, {
    ...values.release, registryPassword: 'forbidden',
  }, values.account, values.deployment), error => error.code === 'runtime_boundary_violation');
  assert.throws(() => createOciDeploymentPlan(values.manifest, values.authority, values.release, {
    ...values.account, name: 'caller-selected',
  }, values.deployment), error => error.code === 'runtime_boundary_violation');
  const plan = createOciDeploymentPlan(values.manifest, values.authority, values.release, values.account, values.deployment);
  const serialized = validateOciDeploymentPlan(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(serialized, plan);
  assert.equal(podmanArguments(serialized).at(-1), values.release.image);
  assert.throws(() => podmanArguments({ ...plan }), error => error.code === 'runtime_boundary_violation');
  assert.throws(() => validateOciDeploymentPlan({
    ...JSON.parse(JSON.stringify(plan)),
    host: { ...plan.host, tenantRoot: '/var/lib/dispatch/tenants/crossed' },
  }), error => error.code === 'runtime_boundary_violation');
  assert.throws(() => renderOciSystemUnit({ ...plan }), error => error.code === 'runtime_boundary_violation');
});

test('production and fixture image channels cannot be confused', () => {
  const values = inputs();
  const local = {
    ...values.release,
    channel: 'fixture',
    image: `localhost/dispatch-runtime@${values.release.imageDigest}`,
  };
  assert.throws(() => createOciDeploymentPlan(values.manifest, values.authority, local, values.account, values.deployment),
    error => error.code === 'invalid_runtime_release');
  assert.equal(
    createOciFixtureDeploymentPlan(values.manifest, values.authority, local, values.account, {
      ...values.deployment, channel: 'fixture',
    }).release.channel,
    'fixture',
  );
});
