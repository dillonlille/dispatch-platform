'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { serverInstallationManifest } = require('../../../shared/contracts/src/installation');
const { HOST_TENANT_ROOT, HOST_BRIDGE_ROOT, opaqueRuntimeSuffix, runtimeKey: identifier } = require('../../runtime-host-identity');
const { MANAGED_INSTALLATION_DIRECTORY_FIELDS, managedInstallationRuntimeEnvironment } = require('../../../shared/paths/runtime-paths');
const BACKEND = 'native_service_v1';
const ISSUED = new WeakSet();
function fail() { throw Object.assign(Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
const hash = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function releaseDescriptor(value) {
  exact(value, ['version', 'backend', 'releaseId', 'channel', 'sourceCommit', 'platform',
    'runtimeAgentProtocol', 'runtimeGatewayProtocol', 'artifactSha256', 'embeddedManifestSha256', 'bridgeManifestSha256']);
  if (value.version !== 1 || value.backend !== BACKEND || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value.releaseId)
      || !['production', 'fixture'].includes(value.channel) || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
      || value.platform !== 'linux/amd64' || value.runtimeAgentProtocol !== 1 || value.runtimeGatewayProtocol !== 1
      || ![value.artifactSha256, value.embeddedManifestSha256, value.bridgeManifestSha256].every(item => /^[a-f0-9]{64}$/.test(item))) fail();
  return Object.freeze({ ...value });
}
function construct(runtimeKey, manifestRevision, releaseValue, accountValue, deployment) {
  identifier(runtimeKey);
  const release = releaseDescriptor(releaseValue);
  const account = require('./oci-deployment').hostAccount(accountValue, runtimeKey);
  exact(deployment, ['version', 'backend', 'channel', 'organizationId', 'runtimeKey', 'manifestRevision', 'releaseId']);
  if (deployment.version !== 1 || deployment.backend !== BACKEND || deployment.channel !== release.channel
      || identifier(deployment.organizationId) !== deployment.organizationId || deployment.runtimeKey !== runtimeKey
      || deployment.manifestRevision !== manifestRevision || deployment.releaseId !== release.releaseId
      || !Number.isSafeInteger(manifestRevision) || manifestRevision < 1) fail();
  const suffix = opaqueRuntimeSuffix(runtimeKey), tenantRoot = path.join(HOST_TENANT_ROOT, suffix);
  const installationRoot = path.join('/var/lib/dispatch', runtimeKey);
  const layout = { layoutVersion: 1, templateId: 'isolated_dsp_v1', runtimeKey, projectRoot: '/opt/dispatch', installationRoot,
    directories: Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS).map(([key, relative]) => [key, path.join(installationRoot, relative)])) };
  const base = {
    version: 1, backend: BACKEND, runtimeKey, manifestRevision, release, deployment: Object.freeze({ ...deployment }), account,
    identity: { suffix, containerName: `dispatch-dsp-${suffix}`, unitName: `dispatch-dsp-${suffix}.service`, bridgeUnitName: `dispatch-runtime-agent-bridge-${suffix}.service` },
    host: { tenantRoot, accountHome: path.join(tenantRoot, 'home'), engineDataRoot: path.join(tenantRoot, 'engine-data'),
      engineConfigRoot: path.join(tenantRoot, 'engine-config'), installationRoot: path.join(tenantRoot, 'runtime', runtimeKey),
      bridgeRoot: path.join(HOST_BRIDGE_ROOT, suffix), unitPath: `/etc/systemd/system/dispatch-dsp-${suffix}.service`,
      bridgeUnitPath: `/etc/systemd/system/dispatch-runtime-agent-bridge-${suffix}.service` },
    guest: { installationRoot, bridgeRoot: '/run/dispatch-agent', environment: {
      DISPATCH_MANAGED_RUNTIME: '1', ...managedInstallationRuntimeEnvironment(layout), DISPATCH_RUNTIME_BACKEND: BACKEND,
      DISPATCH_RUNTIME_KEY: runtimeKey, DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(layout.directories.runtimeRoot, 'runtime-gateway.sock'),
      DISPATCH_RUNTIME_AGENT_HUB_SOCKET: '/run/dispatch-agent/runtime-agent-hub.sock',
      DISPATCH_RUNTIME_AGENT_TOKEN_FILE: path.join(layout.directories.runtimeAgentSecretsRoot, 'registration-token'),
      DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: path.join(layout.directories.runtimeRoot, 'runtime-agent-status.sock'),
      DISPATCH_CHROME_EXECUTABLE: '/opt/dispatch/dependencies/browser/chrome',
    } },
    resources: { id: 'dsp_standard_v1', cpus: '2', memory: '4g', pids: '512', sharedMemory: '512m', temporaryStorage: '512m' },
    security: { user: `${account.uid}:${account.gid}`, readOnlyRoot: true, privateTmp: true, noNewPrivileges: true, browserTransport: 'pipe' },
  };
  for (const value of [base.identity, base.host, base.guest.environment, base.guest, base.resources, base.security]) Object.freeze(value);
  const plan = Object.freeze({ ...base, planDigest: hash(base) }); ISSUED.add(plan); return plan;
}
function createPlan(manifestValue, authority, release, account, deployment, channel = 'production') {
  const manifest = serverInstallationManifest(manifestValue, authority);
  if (manifest.runtime.templateId !== 'isolated_dsp_v1' || manifest.runtime.releaseId !== release.releaseId
      || manifest.organization.id !== deployment.organizationId || release.channel !== channel) fail();
  return construct(manifest.runtime.key, manifest.revision, release, account, deployment);
}
function validatePlan(value) {
  exact(value, ['version', 'backend', 'runtimeKey', 'manifestRevision', 'release', 'deployment', 'account', 'identity', 'host', 'guest', 'resources', 'security', 'planDigest']);
  const plan = construct(value.runtimeKey, value.manifestRevision, value.release, value.account, value.deployment);
  if (JSON.stringify(plan) !== JSON.stringify(value)) fail();
  return plan;
}
function requirePlan(value) { if (!ISSUED.has(value)) fail(); return value; }
function artifactRoot(plan) { requirePlan(plan); return `/opt/dispatch-runtime/releases/${plan.release.releaseId}/runtime-artifact`; }
function renderSystemUnit(value) {
  const plan = requirePlan(value), root = artifactRoot(plan);
  // Private bind aliases preserve runtime paths without an OS image. Every
  // service pins its immutable source release for its entire process lifetime.
  return [
    '[Unit]', `Description=Dispatch DSP runtime (${plan.identity.suffix})`, `After=network-online.target ${plan.identity.bridgeUnitName}`, `Wants=network-online.target ${plan.identity.bridgeUnitName}`,
    'StartLimitIntervalSec=0', '', '[Service]', 'Type=simple',
    `User=${plan.account.name}`, `Group=${plan.account.name}`, 'UMask=0077',
    `BindReadOnlyPaths=${root}:/opt/dispatch ${plan.host.bridgeRoot}:/run/dispatch-agent -${root}/dependencies/node/bin/host-files/usr/share/nodejs:/usr/share/nodejs`,
    `BindPaths=${plan.host.installationRoot}:${plan.guest.installationRoot}`,
    `ReadWritePaths=${plan.host.installationRoot}`, 'WorkingDirectory=/opt/dispatch',
    'Environment=HOME=/tmp/dispatch-home', 'Environment=PATH=/opt/dispatch/dependencies/node/bin:/usr/bin:/bin',
    ...Object.entries(plan.guest.environment).map(([key, selected]) => `Environment=${key}=${selected}`),
    'UnsetEnvironment=NODE_OPTIONS LD_PRELOAD LD_LIBRARY_PATH HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy DISPATCH_LOCAL_ROOT DISPATCH_ACCESS_CONTROL_DATABASE_ROOT',
    // systemd-analyze verifies the executable before entering BindReadOnlyPaths.
    // The immutable release is also visible inside the service namespace.
    `ExecStart=${root}/dependencies/node/bin/node --no-warnings /opt/dispatch/runtime/supervisor/src/supervisor.js`,
    // The supervisor sends TERM to its children. Sending TERM to the entire
    // group here would signal children twice and interrupt their lease cleanup.
    'Restart=on-failure', 'RestartSec=10', 'KillMode=mixed', 'TimeoutStopSec=30',
    'Slice=dispatch-dsp.slice', 'CPUQuota=200%', 'MemoryMax=4G', 'TasksMax=512', 'OOMPolicy=stop',
    'ProtectSystem=strict', 'ProtectHome=true', 'NoNewPrivileges=true',
    'TemporaryFileSystem=/tmp:rw,noexec,nosuid,nodev,size=512M,mode=1777 /dev/shm:rw,noexec,nosuid,nodev,size=512M,mode=1777',
    'InaccessiblePaths=-/run/docker.sock -/run/podman -/run/containerd',
    'ProtectKernelTunables=true', 'ProtectKernelModules=true', 'ProtectControlGroups=true',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK', '', '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
}
module.exports = { BACKEND, releaseDescriptor, createPlan, validatePlan, requirePlan, artifactRoot, renderSystemUnit };
