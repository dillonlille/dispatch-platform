'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { serverInstallationManifest } = require('../../../shared/contracts/src/installation');
const {
  HOST_TENANT_ROOT,
  HOST_BRIDGE_ROOT,
  runtimeKey: checkedRuntimeKey,
  opaqueRuntimeSuffix,
  hostAccountName,
} = require('../../runtime-host-identity');
const {
  MANAGED_INSTALLATION_LAYOUT_VERSION,
  MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
  managedInstallationRuntimeEnvironment,
} = require('../../../shared/paths/runtime-paths');

const OCI_DEPLOYMENT_PLAN_VERSION = 1;
const OCI_DEPLOYMENT_AUTHORITY_VERSION = 1;
const OCI_RELEASE_DESCRIPTOR_VERSION = 2;
const OCI_BACKEND = 'oci_container_v1';
const CONTAINER_UID = 10001;
const CONTAINER_GID = 10001;
const SUBID_COUNT = 65_536;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;

const SYSTEM_UNIT_ROOT = '/etc/systemd/system';
const GUEST_STORAGE_ROOT = '/var/lib/dispatch';
const GUEST_BRIDGE_ROOT = '/run/dispatch-agent';
const PODMAN = '/usr/bin/podman';
const RESOURCE_POLICY = Object.freeze({
  id: 'dsp_standard_v1',
  cpus: '2',
  memory: '4g',
  pids: '512',
  sharedMemory: '512m',
  temporaryStorage: '512m',
});
const ISSUED_PLANS = new WeakSet();

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}

function identifier(value) {
  try { return checkedRuntimeKey(value); } catch { return fail(); }
}

function digest(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail();
  return value;
}

function opaqueSuffix(runtimeKey) {
  try { return opaqueRuntimeSuffix(runtimeKey); } catch { return fail(); }
}

function releaseDescriptor(value) {
  if (value?.backend === 'native_service_v1') return require('./native-deployment').releaseDescriptor(value);
  exact(value, [
    'version', 'backend', 'releaseId', 'channel', 'image', 'imageDigest', 'imageId', 'sourceCommit', 'platform',
    'runtimeAgentProtocol', 'runtimeGatewayProtocol', 'embeddedManifestSha256',
    'imageArchiveSha256', 'bridgeManifestSha256',
  ]);
  if (value.version !== OCI_RELEASE_DESCRIPTOR_VERSION || value.backend !== OCI_BACKEND
      || typeof value.releaseId !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value.releaseId)
      || !['production', 'fixture'].includes(value.channel)
      || !/^[a-f0-9]{64}$/.test(value.imageId)
      || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || value.platform !== 'linux/amd64'
      || ![value.embeddedManifestSha256, value.imageArchiveSha256, value.bridgeManifestSha256]
        .every(item => /^[a-f0-9]{64}$/.test(item))
      || value.runtimeAgentProtocol !== 1 || value.runtimeGatewayProtocol !== 1) fail();
  const imageDigest = digest(value.imageDigest);
  const repository = value.channel === 'production'
    ? 'ghcr.io/example-organization/dispatch-runtime' : 'localhost/dispatch-runtime';
  if (value.image !== `${repository}@${imageDigest}`) fail();
  return Object.freeze({ ...value, imageDigest });
}

function hostAccount(value, runtimeKey) {
  exact(value, ['name', 'uid', 'gid', 'subuidStart', 'subgidStart', 'subidCount']);
  if (value.name !== hostAccountName(runtimeKey)
      || !Number.isSafeInteger(value.uid) || value.uid < 100 || value.uid > 60_000
      || !Number.isSafeInteger(value.gid) || value.gid < 100 || value.gid > 60_000
      || !Number.isSafeInteger(value.subuidStart) || value.subuidStart < 100_000
      || !Number.isSafeInteger(value.subgidStart) || value.subgidStart < 100_000
      || value.subidCount !== SUBID_COUNT) fail();
  return Object.freeze({ ...value });
}

function deploymentAuthority(value, manifest, release, expectedChannel) {
  exact(value, [
    'version', 'backend', 'channel', 'organizationId', 'runtimeKey', 'manifestRevision', 'releaseId',
  ]);
  if (value.version !== OCI_DEPLOYMENT_AUTHORITY_VERSION || value.backend !== OCI_BACKEND
      || value.channel !== expectedChannel || value.organizationId !== manifest.organization.id
      || value.runtimeKey !== manifest.runtime.key || value.manifestRevision !== manifest.revision
      || value.releaseId !== manifest.runtime.releaseId || value.releaseId !== release.releaseId) {
    fail('runtime_identity_mismatch');
  }
  return Object.freeze({ ...value });
}

function guestLayout(runtimeKey) {
  const installationRoot = path.join(GUEST_STORAGE_ROOT, runtimeKey);
  const directories = Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
    .map(([field, relative]) => [field, path.join(installationRoot, relative)]));
  return Object.freeze({
    layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION,
    templateId: MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
    runtimeKey,
    projectRoot: '/opt/dispatch',
    installationRoot,
    directories: Object.freeze(directories),
  });
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function createPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue, expectedChannel) {
  const manifest = serverInstallationManifest(manifestValue, authorityValue);
  const runtimeKey = identifier(manifest.runtime.key);
  if (manifest.runtime.templateId !== MANAGED_INSTALLATION_LAYOUT_TEMPLATE) {
    fail('runtime_boundary_violation');
  }
  const release = releaseDescriptor(releaseValue);
  if (release.channel !== expectedChannel) fail('invalid_runtime_release');
  if (release.releaseId !== manifest.runtime.releaseId) fail('runtime_identity_mismatch');
  const deployment = deploymentAuthority(deploymentValue, manifest, release, expectedChannel);
  const account = hostAccount(accountValue, runtimeKey);
  const suffix = opaqueSuffix(runtimeKey);
  const tenantRoot = path.join(HOST_TENANT_ROOT, suffix);
  const accountHome = path.join(tenantRoot, 'home');
  const engineDataRoot = path.join(tenantRoot, 'engine-data');
  const engineConfigRoot = path.join(tenantRoot, 'engine-config');
  const installationRoot = path.join(tenantRoot, 'runtime', runtimeKey);
  const bridgeRoot = path.join(HOST_BRIDGE_ROOT, suffix);
  const layout = guestLayout(runtimeKey);
  const environment = Object.freeze({
    DISPATCH_MANAGED_RUNTIME: '1',
    ...managedInstallationRuntimeEnvironment(layout),
    DISPATCH_RUNTIME_KEY: runtimeKey,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(layout.directories.runtimeRoot, 'runtime-gateway.sock'),
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: path.join(GUEST_BRIDGE_ROOT, 'runtime-agent-hub.sock'),
    DISPATCH_RUNTIME_AGENT_TOKEN_FILE: path.join(layout.directories.runtimeAgentSecretsRoot, 'registration-token'),
    DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: path.join(layout.directories.runtimeRoot, 'runtime-agent-status.sock'),
    DISPATCH_CHROME_EXECUTABLE: '/usr/bin/chromium',
  });
  for (const socket of [
    environment.DISPATCH_RUNTIME_GATEWAY_SOCKET,
    environment.DISPATCH_RUNTIME_AGENT_HUB_SOCKET,
    environment.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET,
    path.join(bridgeRoot, 'runtime-agent-hub.sock'),
  ]) if (Buffer.byteLength(socket, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) fail();
  const base = Object.freeze({
    version: OCI_DEPLOYMENT_PLAN_VERSION,
    backend: OCI_BACKEND,
    runtimeKey,
    manifestRevision: manifest.revision,
    release,
    deployment,
    account,
    identity: Object.freeze({
      suffix,
      containerName: `dispatch-dsp-${suffix}`,
      unitName: `dispatch-dsp-${suffix}.service`,
      bridgeUnitName: `dispatch-runtime-agent-bridge-${suffix}.service`,
    }),
    host: Object.freeze({
      tenantRoot,
      accountHome,
      engineDataRoot,
      engineConfigRoot,
      installationRoot,
      bridgeRoot,
      unitPath: path.join(SYSTEM_UNIT_ROOT, `dispatch-dsp-${suffix}.service`),
      bridgeUnitPath: path.join(SYSTEM_UNIT_ROOT, `dispatch-runtime-agent-bridge-${suffix}.service`),
    }),
    guest: Object.freeze({
      installationRoot: layout.installationRoot,
      bridgeRoot: GUEST_BRIDGE_ROOT,
      environment,
    }),
    resources: RESOURCE_POLICY,
    security: Object.freeze({
      readOnlyRoot: true,
      network: 'pasta',
      pidNamespace: 'private',
      ipcNamespace: 'private',
      utsNamespace: 'private',
      user: `${CONTAINER_UID}:${CONTAINER_GID}`,
      userNamespace: `keep-id:uid=${CONTAINER_UID},gid=${CONTAINER_GID}`,
      capabilities: Object.freeze(['SYS_CHROOT']),
      noNewPrivileges: true,
      publishPorts: false,
      engineSocketMounted: false,
    }),
  });
  const plan = Object.freeze({ ...base, planDigest: stableDigest(base) });
  ISSUED_PLANS.add(plan);
  return plan;
}

function createOciDeploymentPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue) {
  if (releaseValue?.backend === 'native_service_v1') return require('./native-deployment').createPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue);
  return createPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue, 'production');
}

function createOciFixtureDeploymentPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue) {
  if (releaseValue?.backend === 'native_service_v1') return require('./native-deployment').createPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue, 'fixture');
  return createPlan(manifestValue, authorityValue, releaseValue, accountValue, deploymentValue, 'fixture');
}

function requirePlan(value) {
  if (value?.backend === 'native_service_v1') return require('./native-deployment').requirePlan(value);
  if (!ISSUED_PLANS.has(value) || value.version !== OCI_DEPLOYMENT_PLAN_VERSION) fail();
  return value;
}

function validateOciDeploymentPlan(value) {
  if (value?.backend === 'native_service_v1') return require('./native-deployment').validatePlan(value);
  exact(value, [
    'version', 'backend', 'runtimeKey', 'manifestRevision', 'release', 'deployment', 'account',
    'identity', 'host', 'guest', 'resources', 'security', 'planDigest',
  ]);
  if (value.version !== OCI_DEPLOYMENT_PLAN_VERSION || value.backend !== OCI_BACKEND
      || !Number.isSafeInteger(value.manifestRevision) || value.manifestRevision < 1) fail();
  const runtimeKey = identifier(value.runtimeKey);
  const release = releaseDescriptor(value.release);
  const account = hostAccount(value.account, runtimeKey);
  exact(value.deployment, [
    'version', 'backend', 'channel', 'organizationId', 'runtimeKey', 'manifestRevision', 'releaseId',
  ]);
  if (value.deployment.version !== OCI_DEPLOYMENT_AUTHORITY_VERSION
      || value.deployment.backend !== OCI_BACKEND || value.deployment.channel !== release.channel
      || identifier(value.deployment.organizationId) !== value.deployment.organizationId
      || value.deployment.runtimeKey !== runtimeKey
      || value.deployment.manifestRevision !== value.manifestRevision
      || value.deployment.releaseId !== release.releaseId) fail('runtime_identity_mismatch');
  const suffix = opaqueSuffix(runtimeKey);
  const tenantRoot = path.join(HOST_TENANT_ROOT, suffix);
  const layout = guestLayout(runtimeKey);
  const expected = Object.freeze({
    version: OCI_DEPLOYMENT_PLAN_VERSION,
    backend: OCI_BACKEND,
    runtimeKey,
    manifestRevision: value.manifestRevision,
    release,
    deployment: Object.freeze({ ...value.deployment }),
    account,
    identity: Object.freeze({
      suffix,
      containerName: `dispatch-dsp-${suffix}`,
      unitName: `dispatch-dsp-${suffix}.service`,
      bridgeUnitName: `dispatch-runtime-agent-bridge-${suffix}.service`,
    }),
    host: Object.freeze({
      tenantRoot,
      accountHome: path.join(tenantRoot, 'home'),
      engineDataRoot: path.join(tenantRoot, 'engine-data'),
      engineConfigRoot: path.join(tenantRoot, 'engine-config'),
      installationRoot: path.join(tenantRoot, 'runtime', runtimeKey),
      bridgeRoot: path.join(HOST_BRIDGE_ROOT, suffix),
      unitPath: path.join(SYSTEM_UNIT_ROOT, `dispatch-dsp-${suffix}.service`),
      bridgeUnitPath: path.join(SYSTEM_UNIT_ROOT, `dispatch-runtime-agent-bridge-${suffix}.service`),
    }),
    guest: Object.freeze({
      installationRoot: layout.installationRoot,
      bridgeRoot: GUEST_BRIDGE_ROOT,
      environment: Object.freeze({
        DISPATCH_MANAGED_RUNTIME: '1',
        ...managedInstallationRuntimeEnvironment(layout),
        DISPATCH_RUNTIME_KEY: runtimeKey,
        DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(layout.directories.runtimeRoot, 'runtime-gateway.sock'),
        DISPATCH_RUNTIME_AGENT_HUB_SOCKET: path.join(GUEST_BRIDGE_ROOT, 'runtime-agent-hub.sock'),
        DISPATCH_RUNTIME_AGENT_TOKEN_FILE: path.join(layout.directories.runtimeAgentSecretsRoot, 'registration-token'),
        DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: path.join(layout.directories.runtimeRoot, 'runtime-agent-status.sock'),
        DISPATCH_CHROME_EXECUTABLE: '/usr/bin/chromium',
      }),
    }),
    resources: RESOURCE_POLICY,
    security: Object.freeze({
      readOnlyRoot: true,
      network: 'pasta',
      pidNamespace: 'private',
      ipcNamespace: 'private',
      utsNamespace: 'private',
      user: `${CONTAINER_UID}:${CONTAINER_GID}`,
      userNamespace: `keep-id:uid=${CONTAINER_UID},gid=${CONTAINER_GID}`,
      capabilities: Object.freeze(['SYS_CHROOT']),
      noNewPrivileges: true,
      publishPorts: false,
      engineSocketMounted: false,
    }),
  });
  if (JSON.stringify({ ...expected, planDigest: stableDigest(expected) }) !== JSON.stringify(value)) fail();
  const selected = Object.freeze({ ...expected, planDigest: stableDigest(expected) });
  ISSUED_PLANS.add(selected);
  return selected;
}

function podmanArguments(value) {
  if (value?.backend === 'native_service_v1') fail();
  const plan = requirePlan(value);
  const args = [
    'run', '--rm', '--replace', '--name', plan.identity.containerName,
    '--pull=never', '--http-proxy=false', '--log-driver=journald', `--network=${plan.security.network}`,
    `--pid=${plan.security.pidNamespace}`, `--ipc=${plan.security.ipcNamespace}`, `--uts=${plan.security.utsNamespace}`, '--read-only',
    '--user', plan.security.user, '--userns', plan.security.userNamespace,
    '--cap-drop', 'ALL', '--cap-add', 'SYS_CHROOT', '--security-opt', 'no-new-privileges',
    '--memory', RESOURCE_POLICY.memory, '--cpus', RESOURCE_POLICY.cpus,
    '--pids-limit', RESOURCE_POLICY.pids, '--shm-size', RESOURCE_POLICY.sharedMemory,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${RESOURCE_POLICY.temporaryStorage},mode=1777`,
    '--volume', `${plan.host.installationRoot}:${plan.guest.installationRoot}:rw,rprivate,nosuid,nodev`,
    '--volume', `${plan.host.bridgeRoot}:${plan.guest.bridgeRoot}:ro,rprivate,nosuid,nodev,noexec`,
    '--label', `io.dispatch.runtime-key=${plan.runtimeKey}`,
    '--label', `io.dispatch.release-id=${plan.release.releaseId}`,
    '--label', `io.dispatch.plan-digest=${plan.planDigest}`,
  ];
  for (const [key, selected] of Object.entries(plan.guest.environment).sort(([left], [right]) => left.localeCompare(right))) {
    args.push('--env', `${key}=${selected}`);
  }
  args.push(plan.release.image);
  return Object.freeze(args);
}

function unitWord(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./:@=,+-]+$/.test(value) || /%/.test(value)) fail();
  return value;
}

function renderOciSystemUnit(value) {
  if (value?.backend === 'native_service_v1') return require('./native-deployment').renderSystemUnit(value);
  const plan = requirePlan(value);
  const command = [PODMAN, ...podmanArguments(plan)].map(unitWord).join(' ');
  const stop = [PODMAN, 'stop', '--time', '20', plan.identity.containerName].map(unitWord).join(' ');
  const cleanup = [PODMAN, 'rm', '--force', '--ignore', plan.identity.containerName].map(unitWord).join(' ');
  const lines = [
    '[Unit]',
    `Description=Dispatch isolated DSP runtime (${plan.identity.suffix})`,
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=120',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `User=${unitWord(plan.account.name)}`,
    `Group=${unitWord(plan.account.name)}`,
    `Environment=HOME=${unitWord(plan.host.accountHome)}`,
    `Environment=XDG_DATA_HOME=${unitWord(plan.host.engineDataRoot)}`,
    `Environment=XDG_CONFIG_HOME=${unitWord(plan.host.engineConfigRoot)}`,
    `Environment=XDG_RUNTIME_DIR=/run/user/${plan.account.uid}`,
    'Environment=PATH=/usr/bin:/bin',
    'UnsetEnvironment=NODE_OPTIONS LD_PRELOAD LD_LIBRARY_PATH HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy DISPATCH_LOCAL_ROOT DISPATCH_ACCESS_CONTROL_DATABASE_ROOT',
    `ExecStartPre=${PODMAN} image exists ${unitWord(plan.release.image)}`,
    `ExecStart=${command}`,
    `ExecStop=${stop}`,
    `ExecStopPost=-${cleanup}`,
    'Restart=on-failure',
    'RestartSec=3',
    'KillMode=control-group',
    'TimeoutStartSec=60',
    'TimeoutStopSec=30',
    'UMask=0077',
    'Delegate=yes',
    'Slice=dispatch-dsp.slice',
    'CPUQuota=200%',
    'MemoryMax=4G',
    'TasksMax=512',
    'OOMPolicy=stop',
    'ProtectSystem=strict',
    `ReadWritePaths=${unitWord(plan.host.tenantRoot)} /run/user/${plan.account.uid}`,
    'PrivateTmp=true',
    'LockPersonality=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderOciBridgeSystemUnit(value, options) {
  const plan = requirePlan(value);
  exact(options, ['bridgeExecutable', 'centralSocket', 'centralUid', 'controllerUid']);
  const bridgeExecutable = unitWord(options.bridgeExecutable);
  const centralSocket = unitWord(options.centralSocket);
  if (!path.isAbsolute(bridgeExecutable) || !path.isAbsolute(centralSocket)
      || !Number.isSafeInteger(options.centralUid) || options.centralUid < 1
      || options.controllerUid !== 0
      || options.centralUid === plan.account.uid || options.controllerUid === plan.account.uid
      || options.centralUid === options.controllerUid) fail();
  const lines = [
    '[Unit]',
    `Description=Dispatch Runtime Agent bridge (${plan.identity.suffix})`,
    'After=local-fs.target',
    ...(plan.backend === 'native_service_v1' ? ['StartLimitIntervalSec=0'] : []),
    '',
    '[Service]',
    'Type=simple',
    ...(plan.backend === 'native_service_v1' ? [`RuntimeDirectory=dispatch-runtime-agents dispatch-runtime-agents/${plan.identity.suffix}`,
      'RuntimeDirectoryMode=0711', 'RuntimeDirectoryPreserve=yes'] : []),
    `User=${options.controllerUid}`,
    `Group=${options.controllerUid}`,
    'Environment=PATH=/usr/bin:/bin',
    `Environment=DISPATCH_RUNTIME_BRIDGE_KEY=${unitWord(plan.runtimeKey)}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_UPSTREAM_SOCKET=${centralSocket}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_TENANT_UID=${plan.account.uid}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_TENANT_GID=${plan.account.gid}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_CENTRAL_UID=${options.centralUid}`,

    `ExecStart=/usr/bin/node --no-warnings ${bridgeExecutable}`,
    'Restart=on-failure',
    plan.backend === 'native_service_v1' ? 'RestartSec=5' : 'RestartSec=1',
    'KillMode=control-group',
    'MemoryMax=256M',
    'TasksMax=32',
    'CPUQuota=50%',
    'TimeoutStopSec=15',
    'UMask=0077',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectKernelLogs=true',
    'ProtectControlGroups=true',
    'ProtectClock=true',
    'ProtectHostname=true',
    'PrivateDevices=true',
    'RestrictNamespaces=true',
    'RestrictSUIDSGID=true',
    'SystemCallArchitectures=native',
    'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER',
    `ReadOnlyPaths=${unitWord(path.dirname(bridgeExecutable))}`,
    `ReadWritePaths=${unitWord(plan.host.bridgeRoot)}`,
    'RestrictAddressFamilies=AF_UNIX',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = {
  OCI_DEPLOYMENT_PLAN_VERSION,
  OCI_DEPLOYMENT_AUTHORITY_VERSION,
  OCI_RELEASE_DESCRIPTOR_VERSION,
  OCI_BACKEND,
  CONTAINER_UID,
  CONTAINER_GID,
  SUBID_COUNT,
  HOST_TENANT_ROOT,
  HOST_BRIDGE_ROOT,
  SYSTEM_UNIT_ROOT,
  GUEST_STORAGE_ROOT,
  GUEST_BRIDGE_ROOT,
  RESOURCE_POLICY,
  hostAccountName,
  releaseDescriptor,
  hostAccount,
  createOciDeploymentPlan,
  createOciFixtureDeploymentPlan,
  validateOciDeploymentPlan,
  podmanArguments,
  renderOciSystemUnit,
  renderOciBridgeSystemUnit,
};
