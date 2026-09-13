'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  INSTALLATION_MANIFEST_VERSION,
} = require('dispatch-protocol/contracts/src');
const {
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
} = require('dispatch-protocol/paths/runtime-paths');
const {
  HOST_BRIDGE_ROOT,
  HOST_TENANT_ROOT,
  opaqueRuntimeSuffix,
  hostAccountName,
} = require('dispatch-core/core/runtime-host-identity.js');
const {
  OCI_BACKEND,
  SUBID_COUNT,
  createOciFixtureDeploymentPlan,
  renderOciSystemUnit,
} = require('dispatch-core/core/installations/src/oci-deployment.js');
const {
  CoreRuntimeAgentHub,
  createRuntimeAgentDispatchClient,
} = require('dispatch-core/core/agents/src/index.js');

const IMAGE = 'localhost/dispatch-runtime:dev';
const RUNTIMES = Object.freeze(['runtime_fixture_oci_alpha', 'runtime_fixture_oci_beta']);
const MAX_OUTPUT = 128 * 1024;
const SYSTEM_UNIT_RUNTIME_ROOT = '/run/systemd/system';
const HOST_DISPATCH_ROOT = path.dirname(HOST_TENANT_ROOT);
const HOST_FIXTURE_LOCK = '/run/dispatch-rootless-host-fixture.lock';
const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const { BRIDGE_ARTIFACT_FILES } = require('dispatch-core/core/installations/src/create-bridge-artifact.js');
const REFERENCE_UNITS = Object.freeze(['dispatch-auth-broker.service', 'dispatch-collection-manager.service']);
let currentPhase = 'preflight';

function fail(code = 'rootless_host_fixture_failed', diagnostic = '') {
  throw Object.assign(new Error(code), { code, diagnostic, phase: currentPhase });
}

function lexists(target) {
  try { fs.lstatSync(target); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function run(executable, args, { input, timeout = 120_000, allowFailure = false, environment = process.env } = {}) {
  const result = spawnSync(executable, args, {
    input, encoding: 'utf8', shell: false, timeout, maxBuffer: MAX_OUTPUT, env: environment,
  });
  if (!allowFailure && (result.error || result.signal || result.status !== 0)) {
    fail('rootless_host_fixture_failed', JSON.stringify({
      executable: path.basename(executable),
      status: result.status,
      signal: result.signal,
      error: String(result.stderr || '').slice(-1024),
    }));
  }
  return result;
}

function sudo(args, options = {}) {
  return run('/usr/bin/sudo', ['-n', ...args], options);
}

function accountEnvironment(account) {
  return Object.freeze({
    HOME: account.home,
    XDG_DATA_HOME: account.engineDataRoot,
    XDG_CONFIG_HOME: account.engineConfigRoot,
    XDG_RUNTIME_DIR: `/run/user/${account.uid}`,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
  });
}

function accountCommand(account, executable, args, options = {}) {
  const assignments = Object.entries(accountEnvironment(account)).map(([key, value]) => `${key}=${value}`);
  return sudo(['-u', account.name, '/usr/bin/env', '-i', ...assignments, executable, ...args], options);
}

function accountPodman(account, args, options = {}) {
  return accountCommand(account, '/usr/bin/podman', args, options);
}

function accountExists(name) {
  return run('/usr/bin/getent', ['passwd', name], { allowFailure: true }).status === 0;
}

function systemUnitExists(name) {
  return run('/usr/bin/systemctl', ['show', name, '--property=LoadState', '--value'], { allowFailure: true }).stdout.trim() !== 'not-found';
}

function verifyUnitFragment(name, expectedPath) {
  const output = run('/usr/bin/systemctl', [
    'show', name, '--property=LoadState', '--property=FragmentPath',
  ]).stdout;
  if (!output.includes('LoadState=loaded\n') || !output.includes(`FragmentPath=${expectedPath}\n`)) fail();
}

function parseSubids(file) {
  const ranges = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length !== 3) fail();
    const start = Number(parts[1]);
    const count = Number(parts[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1) fail();
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function allocateSubids(count) {
  const ranges = [...parseSubids('/etc/subuid'), ...parseSubids('/etc/subgid')];
  const maximum = ranges.reduce((value, range) => Math.max(value, range.end + 1), 1_000_000);
  const aligned = Math.max(1_000_000, Math.ceil(maximum / SUBID_COUNT) * SUBID_COUNT);
  return Array.from({ length: count }, (_, index) => aligned + index * SUBID_COUNT);
}

function rangePresent(file, name, start) {
  return fs.readFileSync(file, 'utf8').split('\n').includes(`${name}:${start}:${SUBID_COUNT}`);
}

function referenceSnapshot() {
  return Object.fromEntries(REFERENCE_UNITS.map(name => {
    const active = run('/usr/bin/systemctl', ['--user', 'is-active', name], { allowFailure: true }).stdout.trim();
    const pid = run('/usr/bin/systemctl', ['--user', 'show', name, '--property=MainPID', '--value'], { allowFailure: true }).stdout.trim();
    return [name, { active, pid }];
  }));
}

function imageIdentity() {
  const value = JSON.parse(run('/usr/bin/podman', ['image', 'inspect', IMAGE]).stdout)[0];
  if (!/^sha256:[a-f0-9]{64}$/.test(value?.Digest || '') || !/^[a-f0-9]{64}$/.test(value?.Id || '')) fail();
  return Object.freeze({ digest: value.Digest, id: value.Id });
}

function sourceCommit() {
  const value = run('/usr/bin/git', ['rev-parse', 'HEAD']).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(value)) fail();
  return value;
}

function ensureHostRoot(target, mode) {
  if (lexists(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== mode
        || fs.realpathSync(target) !== target) fail('unsafe_fixture_host_root');
    return false;
  }
  sudo(['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', mode.toString(8).padStart(4, '0'), target]);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== mode
      || fs.realpathSync(target) !== target) fail('unsafe_fixture_host_root');
  return true;
}

function createAccount(runtimeKey, subidStart) {
  const suffix = opaqueRuntimeSuffix(runtimeKey);
  const name = hostAccountName(runtimeKey);
  const tenantRoot = path.join(HOST_TENANT_ROOT, suffix);
  const home = path.join(tenantRoot, 'home');
  if (accountExists(name) || lexists(tenantRoot) || lexists(path.join(HOST_BRIDGE_ROOT, suffix))) fail();
  sudo(['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', tenantRoot]);
  sudo(['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', home, '--create-home', '--shell', '/usr/sbin/nologin', name]);
  const passwd = run('/usr/bin/getent', ['passwd', name]).stdout.trim().split(':');
  const uid = Number(passwd[2]);
  const gid = Number(passwd[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || passwd[5] !== home || passwd[6] !== '/usr/sbin/nologin') fail();
  const passwordStatus = sudo(['/usr/bin/passwd', '--status', name]).stdout.trim().split(/\s+/);
  if (passwordStatus[0] !== name || passwordStatus[1] !== 'L') fail('fixture_account_not_locked');
  sudo(['/usr/sbin/usermod', '--add-subuids', `${subidStart}-${subidStart + SUBID_COUNT - 1}`, '--add-subgids', `${subidStart}-${subidStart + SUBID_COUNT - 1}`, name]);
  sudo(['/usr/bin/chown', `${name}:${name}`, tenantRoot]);
  sudo(['/usr/bin/chmod', '0700', tenantRoot]);
  const engineDataRoot = path.join(tenantRoot, 'engine-data');
  const engineConfigRoot = path.join(tenantRoot, 'engine-config');
  const installationRoot = path.join(tenantRoot, 'runtime', runtimeKey);
  const bridgeRoot = path.join(HOST_BRIDGE_ROOT, suffix);
  const ownedDirectories = [home, engineDataRoot, engineConfigRoot, path.dirname(installationRoot), installationRoot];
  const layoutDirectories = Object.values(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
    .map(relative => path.join(installationRoot, relative));
  for (const directory of [...ownedDirectories, ...layoutDirectories]
    .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right))) {
    sudo(['/usr/bin/install', '-d', '-o', name, '-g', name, '-m', '0700', directory]);
  }
  sudo(['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0711', bridgeRoot]);
  sudo(['/usr/bin/loginctl', 'enable-linger', name]);
  sudo(['/usr/bin/systemctl', 'start', `user@${uid}.service`]);
  const groups = run('/usr/bin/id', ['-Gn', name]).stdout.trim().split(/\s+/);
  if (groups.length !== 1 || groups[0] !== name || !rangePresent('/etc/subuid', name, subidStart)
      || !rangePresent('/etc/subgid', name, subidStart)) fail();
  const runtimeDirectory = fs.lstatSync(`/run/user/${uid}`);
  if (!runtimeDirectory.isDirectory() || runtimeDirectory.uid !== uid || (runtimeDirectory.mode & 0o7777) !== 0o700) fail();
  return {
    runtimeKey, suffix, name, uid, gid, subuidStart: subidStart, subgidStart: subidStart,
    subidCount: SUBID_COUNT, tenantRoot, home, engineDataRoot, engineConfigRoot,
    installationRoot, bridgeRoot,
  };
}

function writeToken(account, token, fixtureRoot) {
  const temporary = path.join(fixtureRoot, `${account.suffix}.token`);
  fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' });
  const target = path.join(account.installationRoot, 'secrets', 'runtime-agent', 'registration-token');
  sudo(['/usr/bin/install', '-o', account.name, '-g', account.name, '-m', '0600', temporary, target]);
  fs.unlinkSync(temporary);
}

function installRuntimeUnit(plan, fixtureRoot) {
  const temporary = path.join(fixtureRoot, plan.identity.unitName);
  const content = renderOciSystemUnit(plan);
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  run('/usr/bin/systemd-analyze', ['verify', temporary]);
  const installed = path.join(SYSTEM_UNIT_RUNTIME_ROOT, plan.identity.unitName);
  try {
    sudo(['/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', temporary, installed]);
    const stat = fs.lstatSync(installed);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
        || (stat.mode & 0o7777) !== 0o644 || fs.readFileSync(installed, 'utf8') !== content) fail();
    return installed;
  } catch (error) {
    sudo(['/usr/bin/rm', '--force', installed], { allowFailure: true });
    throw error;
  }
}

function stageBridgeArtifact(artifactRoot) {
  for (const relative of BRIDGE_ARTIFACT_FILES) {
    const source = path.join(REPOSITORY_ROOT, relative);
    const sourceInfo = fs.lstatSync(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1
        || sourceInfo.uid !== process.geteuid() || (sourceInfo.mode & 0o022) !== 0
        || fs.realpathSync(source) !== source) fail('unsafe_fixture_source');
    const destination = path.join(artifactRoot, relative);
    const segments = path.dirname(relative).split(path.sep);
    for (let index = 1; index <= segments.length; index += 1) {
      const directory = path.join(artifactRoot, ...segments.slice(0, index));
      sudo(['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0555', directory]);
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
          || (info.mode & 0o7777) !== 0o555 || fs.realpathSync(directory) !== directory) fail('unsafe_fixture_bridge_artifact');
    }
    sudo(['/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0444', source, destination]);
    const destinationInfo = fs.lstatSync(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || destinationInfo.nlink !== 1
        || destinationInfo.uid !== 0 || destinationInfo.gid !== 0 || (destinationInfo.mode & 0o7777) !== 0o444
        || fs.realpathSync(destination) !== destination
        || !fs.readFileSync(source).equals(fs.readFileSync(destination))) fail('unsafe_fixture_bridge_artifact');
  }
  return path.join(artifactRoot, 'core/agent-bridge/src/service-cli.js');
}

function bridgeUnit(account, centralSocket, centralUid, fixtureRoot, bridgeArtifactRoot, bridgeService) {
  const name = `dispatch-fixture-bridge-${account.suffix}.service`;
  if (bridgeService !== path.join(bridgeArtifactRoot, 'core/agent-bridge/src/service-cli.js')) fail();
  const content = [
    '[Unit]',
    `Description=Dispatch fixture Runtime Agent bridge (${account.suffix})`,
    '',
    '[Service]',
    'Type=simple',
    'User=root',
    'Group=root',
    'Environment=PATH=/usr/bin:/bin',
    `Environment=DISPATCH_RUNTIME_BRIDGE_KEY=${account.runtimeKey}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_UPSTREAM_SOCKET=${centralSocket}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_TENANT_UID=${account.uid}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_TENANT_GID=${account.gid}`,
    `Environment=DISPATCH_RUNTIME_BRIDGE_CENTRAL_UID=${centralUid}`,
    `ExecStart=/usr/bin/node --no-warnings ${bridgeService}`,
    'Restart=on-failure',
    'RestartSec=1',
    'KillMode=control-group',
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
    `ReadOnlyPaths=${bridgeArtifactRoot}`,
    `ReadWritePaths=${account.bridgeRoot}`,
    'RestrictAddressFamilies=AF_UNIX',
    '',
  ].join('\n');
  const temporary = path.join(fixtureRoot, name);
  const unitContent = `${content}\n`;
  fs.writeFileSync(temporary, unitContent, { mode: 0o600, flag: 'wx' });
  run('/usr/bin/systemd-analyze', ['verify', temporary]);
  const installed = path.join(SYSTEM_UNIT_RUNTIME_ROOT, name);
  try {
    sudo(['/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', temporary, installed]);
    const stat = fs.lstatSync(installed);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
        || (stat.mode & 0o7777) !== 0o644 || fs.readFileSync(installed, 'utf8') !== unitContent) fail();
    return { name, installed };
  } catch (error) {
    sudo(['/usr/bin/rm', '--force', installed], { allowFailure: true });
    throw error;
  }
}

function inspectAccountImage(account, expectedId) {
  const image = JSON.parse(accountPodman(account, ['image', 'inspect', IMAGE]).stdout)[0];
  const reference = (image?.RepoDigests || []).find(value => value.startsWith('localhost/dispatch-runtime@sha256:'));
  if (!/^sha256:[a-f0-9]{64}$/.test(image?.Digest || '')
      || reference !== `localhost/dispatch-runtime@${image.Digest}`
      || image?.Id !== expectedId || image?.Config?.User !== '10001:10001') fail();
  return Object.freeze({ digest: image.Digest, id: image.Id, reference });
}

function verifyAccountImageManifest(account, reference, source) {
  const code = 'const m=require("/opt/dispatch/runtime-release-manifest.json");process.stdout.write(JSON.stringify(m));';
  const value = JSON.parse(accountPodman(account, [
    'run', '--rm', '--pull=never', '--network=none', '--read-only', '--entrypoint', '/usr/local/bin/node',
    reference, '--no-warnings', '-e', code,
  ], { timeout: 30_000 }).stdout);
  if (value?.schemaVersion !== 1 || value.sourceCommit !== source || !['clean', 'dirty'].includes(value.sourceState)
      || value.protocols?.runtimeAgent !== 1 || value.protocols?.runtimeGateway !== 1
      || typeof value.codeTreeDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.codeTreeDigest)) fail();
}

function inspectContainer(account, plan) {
  const value = JSON.parse(accountPodman(account, ['inspect', plan.identity.containerName]).stdout)[0];
  const mounts = (value?.Mounts || []).map(item => ({ source: item.Source, destination: item.Destination }));
  const runtimeMount = mounts.find(item => item.destination === plan.guest.installationRoot);
  const bridgeMount = mounts.find(item => item.destination === plan.guest.bridgeRoot);
  const processStatus = fs.readFileSync(`/proc/${value?.State?.Pid}/status`, 'utf8');
  if (value?.Config?.User !== '10001:10001' || value?.HostConfig?.ReadonlyRootfs !== true
      || value?.HostConfig?.NetworkMode !== 'pasta'
      || value?.HostConfig?.PidMode !== 'private' || value?.HostConfig?.IpcMode !== 'private'
      || value?.HostConfig?.UTSMode !== 'private'
      || value?.HostConfig?.PidsLimit !== 512 || value?.HostConfig?.Memory !== 4 * 1024 * 1024 * 1024
      || value?.HostConfig?.NanoCpus !== 2_000_000_000 || value?.HostConfig?.ShmSize !== 512 * 1024 * 1024
      || JSON.stringify(value?.HostConfig?.SecurityOpt) !== JSON.stringify(['no-new-privileges'])
      || !value?.HostConfig?.Tmpfs?.['/tmp']?.includes('noexec')
      || JSON.stringify(value?.EffectiveCaps || []) !== JSON.stringify(['CAP_SYS_CHROOT'])
      || value?.Path !== '/usr/bin/tini' || (value?.NetworkSettings?.Ports && Object.keys(value.NetworkSettings.Ports).length !== 0)
      || mounts.length !== 2 || runtimeMount?.source !== plan.host.installationRoot
      || bridgeMount?.source !== plan.host.bridgeRoot
      || !new RegExp(`^Uid:\\s+${account.uid}\\s`, 'm').test(processStatus)) fail();
  return value;
}

async function waitFor(check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  fail();
}

function partialAccount(runtimeKey) {
  const suffix = opaqueRuntimeSuffix(runtimeKey);
  const name = hostAccountName(runtimeKey);
  if (!accountExists(name)) return null;
  const passwd = run('/usr/bin/getent', ['passwd', name]).stdout.trim().split(':');
  const uid = Number(passwd[2]);
  const gid = Number(passwd[3]);
  const tenantRoot = path.join(HOST_TENANT_ROOT, suffix);
  return {
    runtimeKey,
    suffix,
    name,
    uid,
    gid,
    tenantRoot,
    home: path.join(tenantRoot, 'home'),
    engineDataRoot: path.join(tenantRoot, 'engine-data'),
    engineConfigRoot: path.join(tenantRoot, 'engine-config'),
    bridgeRoot: path.join(HOST_BRIDGE_ROOT, suffix),
  };
}

function removeAccount(account) {
  accountPodman(account, ['system', 'reset', '--force'], { allowFailure: true, timeout: 120_000 });
  sudo(['/usr/bin/loginctl', 'disable-linger', account.name], { allowFailure: true });
  sudo(['/usr/bin/systemctl', 'stop', `user@${account.uid}.service`], { allowFailure: true });
  sudo(['/usr/bin/systemctl', 'stop', `user-runtime-dir@${account.uid}.service`], { allowFailure: true });
  sudo(['/usr/sbin/userdel', '--remove', account.name], { allowFailure: true });
  sudo(['/usr/bin/rm', '--recursive', '--force', '--one-file-system', account.tenantRoot], { allowFailure: true });
  sudo(['/usr/bin/rm', '--recursive', '--force', '--one-file-system', account.bridgeRoot], { allowFailure: true });
}

async function runFixture() {
  const before = referenceSnapshot();
  const bridgeArtifactRoot = path.join('/run', `dispatch-rootless-bridge-artifact-${process.pid}`);
  if (lexists(bridgeArtifactRoot)) fail('fixture_preexisting');
  for (const runtimeKey of RUNTIMES) {
    const suffix = opaqueRuntimeSuffix(runtimeKey);
    const accountName = hostAccountName(runtimeKey);
    const runtimeUnit = `dispatch-dsp-${suffix}.service`;
    const bridgeName = `dispatch-fixture-bridge-${suffix}.service`;
    if (accountExists(accountName) || run('/usr/bin/getent', ['group', accountName], { allowFailure: true }).status === 0
        || systemUnitExists(runtimeUnit) || systemUnitExists(bridgeName)
        || lexists(path.join(SYSTEM_UNIT_RUNTIME_ROOT, runtimeUnit))
        || lexists(path.join(SYSTEM_UNIT_RUNTIME_ROOT, bridgeName))
        || lexists(path.join(HOST_TENANT_ROOT, suffix))
        || lexists(path.join(HOST_BRIDGE_ROOT, suffix))
        || sudo(['/usr/bin/test', '!', '-e', `/var/lib/systemd/linger/${accountName}`], { allowFailure: true }).status !== 0) {
      fail('fixture_preexisting');
    }
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rootless-host-'));
  const accounts = [];
  const runtimeUnits = [];
  const bridgeUnits = [];
  const createdHostRoots = [];
  let hub;
  let centralRoot;
  let archiveRoot;
  let archive;
  let archiveRootIdentity;
  let archiveIdentity;
  let bridgeArtifactIdentity;
  let bridgeArtifactCreated = false;
  try {
    if (ensureHostRoot(HOST_DISPATCH_ROOT, 0o755)) createdHostRoots.push(HOST_DISPATCH_ROOT);
    if (ensureHostRoot(HOST_TENANT_ROOT, 0o755)) createdHostRoots.push(HOST_TENANT_ROOT);
    if (ensureHostRoot(HOST_BRIDGE_ROOT, 0o711)) createdHostRoots.push(HOST_BRIDGE_ROOT);
    currentPhase = 'image_archive';
    archiveRoot = fs.mkdtempSync(path.join('/var/tmp', 'dispatch-runtime-fixture-'));
    fs.chmodSync(archiveRoot, 0o711);
    const archiveRootInfo = fs.lstatSync(archiveRoot);
    if (!archiveRootInfo.isDirectory() || archiveRootInfo.uid !== process.geteuid()
        || archiveRootInfo.gid !== process.getegid() || (archiveRootInfo.mode & 0o7777) !== 0o711
        || fs.realpathSync(archiveRoot) !== archiveRoot) fail('unsafe_fixture_archive');
    archiveRootIdentity = Object.freeze({ dev: archiveRootInfo.dev, ino: archiveRootInfo.ino });
    archive = path.join(archiveRoot, 'runtime-image.tar');
    sudo(['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0555', bridgeArtifactRoot]);
    bridgeArtifactCreated = true;
    const artifactInfo = fs.lstatSync(bridgeArtifactRoot);
    if (!artifactInfo.isDirectory() || artifactInfo.uid !== 0 || artifactInfo.gid !== 0
        || (artifactInfo.mode & 0o7777) !== 0o555 || fs.realpathSync(bridgeArtifactRoot) !== bridgeArtifactRoot) {
      fail('unsafe_fixture_bridge_artifact');
    }
    bridgeArtifactIdentity = Object.freeze({ dev: artifactInfo.dev, ino: artifactInfo.ino });
    const bridgeService = stageBridgeArtifact(bridgeArtifactRoot);
    const sourceImage = imageIdentity();
    const source = sourceCommit();
    run('/usr/bin/podman', ['save', '--format', 'docker-archive', '--output', archive, IMAGE], { timeout: 300_000 });
    fs.chmodSync(archive, 0o644);
    const archiveInfo = fs.lstatSync(archive);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.nlink !== 1
        || archiveInfo.uid !== process.geteuid() || archiveInfo.gid !== process.getegid()
        || (archiveInfo.mode & 0o7777) !== 0o644 || fs.realpathSync(archive) !== archive) fail('unsafe_fixture_archive');
    archiveIdentity = Object.freeze({ dev: archiveInfo.dev, ino: archiveInfo.ino });
    currentPhase = 'accounts';
    const subids = allocateSubids(RUNTIMES.length);
    for (let index = 0; index < RUNTIMES.length; index += 1) accounts.push(createAccount(RUNTIMES[index], subids[index]));
    if (accounts[0].uid === accounts[1].uid || accounts[0].gid === accounts[1].gid
        || accounts[0].subuidStart + SUBID_COUNT > accounts[1].subuidStart) fail();

    currentPhase = 'account_images';
    const authorities = {};
    let digest = null;
    for (const account of accounts) {
      const token = crypto.randomBytes(32).toString('base64url');
      currentPhase = `account_token_${account.suffix}`;
      writeToken(account, token, fixtureRoot);
      authorities[account.runtimeKey] = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
      currentPhase = `account_image_load_${account.suffix}`;
      const loaded = accountPodman(account, ['load', '--input', archive], { timeout: 300_000 });
      if (loaded.status !== 0) fail();
      currentPhase = `account_image_inspect_${account.suffix}`;
      const loadedImage = inspectAccountImage(account, sourceImage.id);
      verifyAccountImageManifest(account, loadedImage.reference, source);
      if (digest !== null && loadedImage.digest !== digest) fail();
      digest = loadedImage.digest;
      if (accountPodman(account, ['image', 'exists', loadedImage.reference], { allowFailure: true }).status !== 0) {
        fail('rootless_host_fixture_failed', 'loaded_image_digest_not_addressable');
      }
      currentPhase = `account_engine_inspect_${account.suffix}`;
      const graphRoot = JSON.parse(accountPodman(account, ['info', '--format', 'json']).stdout)?.store?.graphRoot;
      if (graphRoot !== path.join(account.engineDataRoot, 'containers', 'storage')) fail();
    }

    currentPhase = 'central_hub';
    const currentRuntimeRoot = process.env.XDG_RUNTIME_DIR || `/run/user/${process.geteuid()}`;
    centralRoot = fs.mkdtempSync(path.join(currentRuntimeRoot, 'dispatch-rootless-hub-'));
    fs.chmodSync(centralRoot, 0o700);
    const centralSocket = path.join(centralRoot, 'runtime-agent-hub.sock');
    hub = new CoreRuntimeAgentHub({
      socketPath: centralSocket,
      authorities,
      heartbeatIntervalMs: 500,
      heartbeatTimeoutMs: 3_000,
    });
    await hub.start();

    currentPhase = 'bridges';
    for (const account of accounts) {
      bridgeUnits.push(bridgeUnit(account, centralSocket, process.geteuid(), fixtureRoot, bridgeArtifactRoot, bridgeService));
    }
    sudo(['/usr/bin/systemctl', 'daemon-reload']);
    for (const unit of bridgeUnits) verifyUnitFragment(unit.name, unit.installed);
    for (const unit of bridgeUnits) sudo(['/usr/bin/systemctl', 'reset-failed', unit.name], { allowFailure: true });
    for (const unit of bridgeUnits) sudo(['/usr/bin/systemctl', 'start', unit.name]);
    await waitFor(() => accounts.every(account => {
      const socket = path.join(account.bridgeRoot, 'runtime-agent-hub.sock');
      const info = fs.lstatSync(socket);
      const parent = fs.lstatSync(account.bridgeRoot);
      const root = fs.lstatSync(HOST_BRIDGE_ROOT);
      return info.isSocket() && info.uid === account.uid && info.gid === account.gid && (info.mode & 0o7777) === 0o600
        && parent.isDirectory() && parent.uid === 0 && parent.gid === 0 && (parent.mode & 0o7777) === 0o711
        && root.isDirectory() && root.uid === 0 && root.gid === 0 && (root.mode & 0o7777) === 0o711;
    }));
    const centralRootInfo = fs.lstatSync(centralRoot);
    const centralSocketInfo = fs.lstatSync(centralSocket);
    if (!centralRootInfo.isDirectory() || centralRootInfo.uid !== process.geteuid()
        || (centralRootInfo.mode & 0o7777) !== 0o700 || !centralSocketInfo.isSocket()
        || centralSocketInfo.uid !== process.geteuid() || (centralSocketInfo.mode & 0o7777) !== 0o600) fail();
    for (const unit of bridgeUnits) {
      const properties = run('/usr/bin/systemctl', [
        'show', unit.name, '--property=User', '--property=Group', '--property=ActiveState',
        '--property=MainPID', '--property=ExecStart', '--property=CapabilityBoundingSet',
      ]).stdout;
      if (!properties.includes('User=root\n') || !properties.includes('Group=root\n')
          || !properties.includes('ActiveState=active\n') || !properties.includes(bridgeService)
          || !properties.includes('cap_chown') || !properties.includes('cap_dac_override')
          || !properties.includes('cap_fowner')) fail();
    }
    for (const account of accounts) {
      const socket = path.join(account.bridgeRoot, 'runtime-agent-hub.sock');
      const before = fs.lstatSync(socket);
      if (accountCommand(account, '/usr/bin/test', ['-w', account.bridgeRoot], { allowFailure: true }).status === 0
          || accountCommand(account, '/usr/bin/rm', ['--force', socket], { allowFailure: true }).status === 0) fail();
      const after = fs.lstatSync(socket);
      if (before.dev !== after.dev || before.ino !== after.ino) fail();
    }

    currentPhase = 'runtime_units';
    const plans = accounts.map(account => {
      const manifest = {
        manifestVersion: INSTALLATION_MANIFEST_VERSION,
        revision: 1,
        organization: { id: `organization_${account.suffix}`, stationCode: 'DXX1', timezone: 'America/Chicago' },
        runtime: { key: account.runtimeKey, templateId: 'isolated_dsp_v1', releaseId: 'dispatch-runtime-fixture' },
      };
      const authority = { revision: 1, organization: { ...manifest.organization }, runtime: { ...manifest.runtime } };
      const release = {
        version: 2, backend: OCI_BACKEND, releaseId: manifest.runtime.releaseId,
        channel: 'fixture', image: `localhost/dispatch-runtime@${digest}`,
        imageDigest: digest, sourceCommit: source, platform: 'linux/amd64',
        imageId: sourceImage.id,
        runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1,
        embeddedManifestSha256: 'c'.repeat(64), imageArchiveSha256: 'd'.repeat(64),
        bridgeManifestSha256: 'e'.repeat(64),
      };
      const deployment = {
        version: 1,
        backend: OCI_BACKEND,
        channel: 'fixture',
        organizationId: manifest.organization.id,
        runtimeKey: manifest.runtime.key,
        manifestRevision: manifest.revision,
        releaseId: manifest.runtime.releaseId,
      };
      return createOciFixtureDeploymentPlan(manifest, authority, release, {
        name: account.name, uid: account.uid, gid: account.gid,
        subuidStart: account.subuidStart, subgidStart: account.subgidStart, subidCount: SUBID_COUNT,
      }, deployment);
    });
    for (const plan of plans) runtimeUnits.push({ name: plan.identity.unitName, installed: installRuntimeUnit(plan, fixtureRoot) });
    sudo(['/usr/bin/systemctl', 'daemon-reload']);
    for (const unit of runtimeUnits) verifyUnitFragment(unit.name, unit.installed);
    for (const unit of runtimeUnits) sudo(['/usr/bin/systemctl', 'reset-failed', unit.name], { allowFailure: true });
    for (const unit of runtimeUnits) sudo(['/usr/bin/systemctl', 'start', unit.name]);
    await waitFor(() => accounts.every(account => hub.connected(account.runtimeKey)), 90_000);

    for (const account of accounts) {
      const result = await createRuntimeAgentDispatchClient({ hub, runtimeKey: account.runtimeKey }).system.status();
      if (!result?.ok) fail();
    }
    currentPhase = 'isolation_verification';
    const containers = plans.map((plan, index) => inspectContainer(accounts[index], plan));
    if (containers[0].State.Pid === containers[1].State.Pid) fail();
    if (accountPodman(accounts[0], ['inspect', plans[1].identity.containerName], { allowFailure: true }).status === 0) fail();
    const betaToken = path.join(accounts[1].installationRoot, 'secrets', 'runtime-agent', 'registration-token');
    if (accountCommand(accounts[0], '/usr/bin/test', ['-r', betaToken], { allowFailure: true }).status === 0) fail();
    if (accountCommand(accounts[0], '/usr/bin/kill', ['-0', String(containers[1].State.Pid)], { allowFailure: true }).status === 0) fail();
    const betaSocket = path.join(accounts[1].bridgeRoot, 'runtime-agent-hub.sock');
    const crossSocket = accountCommand(accounts[0], '/usr/bin/node', ['-e',
      'const net=require("node:net");const s=net.createConnection(process.argv[1]);s.on("connect",()=>process.exit(1));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),1000);', betaSocket], { allowFailure: true });
    if (crossSocket.status !== 0) fail();

    currentPhase = 'bridge_restart_recovery';
    const alphaBridgePid = run('/usr/bin/systemctl', ['show', bridgeUnits[0].name, '--property=MainPID', '--value']).stdout.trim();
    const betaBridgePid = run('/usr/bin/systemctl', ['show', bridgeUnits[1].name, '--property=MainPID', '--value']).stdout.trim();
    sudo(['/usr/bin/systemctl', 'kill', '--kill-whom=main', '--signal=KILL', bridgeUnits[0].name]);
    let bridgeDisconnected = false;
    await waitFor(() => {
      if (!hub.connected(accounts[0].runtimeKey)) bridgeDisconnected = true;
      const current = run('/usr/bin/systemctl', ['show', bridgeUnits[0].name, '--property=MainPID', '--value'], { allowFailure: true }).stdout.trim();
      return bridgeDisconnected && current && current !== '0' && current !== alphaBridgePid && hub.connected(accounts[0].runtimeKey);
    }, 60_000);
    if (run('/usr/bin/systemctl', ['show', bridgeUnits[1].name, '--property=MainPID', '--value']).stdout.trim() !== betaBridgePid
        || !hub.connected(accounts[1].runtimeKey)) fail();

    const browser = accountPodman(accounts[0], [
      'exec', '--env', 'HOME=/tmp/browser-profile', plans[0].identity.containerName,
      '/usr/bin/chromium', '--headless=new', '--disable-gpu', '--user-data-dir=/tmp/browser-profile', '--dump-dom', 'about:blank',
    ], { timeout: 45_000 });
    if (!/<html/i.test(browser.stdout) || browser.stdout.includes('--no-sandbox')) fail();
    accountPodman(accounts[0], [
      'exec', '--detach', '--env', 'HOME=/tmp/dispatch-sandbox-proof', plans[0].identity.containerName,
      '/usr/bin/chromium', '--headless=new', '--disable-gpu',
      '--user-data-dir=/tmp/dispatch-sandbox-proof', '--remote-debugging-port=0', 'about:blank',
    ]);
    await waitFor(() => {
      const result = accountPodman(accounts[0], [
        'exec', plans[0].identity.containerName, '/usr/local/bin/node', '--no-warnings',
        '/opt/dispatch/runtime/supervisor/src/chromium-sandbox-status.js',
      ], { allowFailure: true });
      if (result.status !== 0) return false;
      const value = JSON.parse(result.stdout.trim());
      return value.ok === true && value.status === 'sandboxed';
    }, 20_000);
    accountPodman(accounts[0], [
      'exec', plans[0].identity.containerName, '/usr/bin/pkill', '-TERM', '-f',
      'user-data-dir=/tmp/dispatch-sandbox-proof',
    ]);

    currentPhase = 'restart_recovery';
    const betaMainPid = run('/usr/bin/systemctl', ['show', plans[1].identity.unitName, '--property=MainPID', '--value']).stdout.trim();
    const alphaMainPid = run('/usr/bin/systemctl', ['show', plans[0].identity.unitName, '--property=MainPID', '--value']).stdout.trim();
    accountPodman(accounts[0], ['exec', plans[0].identity.containerName, '/usr/bin/pkill', '-TERM', '-f', 'auth-broker/bin/dispatch-auth-broker']);
    await waitFor(() => {
      const current = run('/usr/bin/systemctl', ['show', plans[0].identity.unitName, '--property=MainPID', '--value'], { allowFailure: true }).stdout.trim();
      return current && current !== '0' && current !== alphaMainPid && hub.connected(accounts[0].runtimeKey);
    }, 60_000);
    if (run('/usr/bin/systemctl', ['show', plans[1].identity.unitName, '--property=MainPID', '--value']).stdout.trim() !== betaMainPid
        || !hub.connected(accounts[1].runtimeKey)) fail();

    const status = plans.map(plan => run('/usr/bin/systemctl', [
      'show', plan.identity.unitName, '--property=User', '--property=Slice', '--property=MemoryMax', '--property=TasksMax',
      '--property=CPUQuotaPerSecUSec', '--property=ActiveState',
    ]).stdout);
    for (let index = 0; index < plans.length; index += 1) {
      if (!status[index].includes(`User=${accounts[index].name}\n`) || !status[index].includes('Slice=dispatch-dsp.slice\n')
          || !status[index].includes('MemoryMax=4294967296\n') || !status[index].includes('TasksMax=512\n')
          || !status[index].includes('CPUQuotaPerSecUSec=2s\n')
          || !status[index].includes('ActiveState=active\n')) fail();
      if (accountPodman(accounts[index], ['healthcheck', 'run', plans[index].identity.containerName], { allowFailure: true }).status !== 0) fail();
    }

  } catch (error) {
    if (!error.phase) error.phase = currentPhase;
    throw error;
  } finally {
    currentPhase = 'cleanup';
    for (const unit of runtimeUnits) sudo(['/usr/bin/systemctl', 'stop', unit.name], { allowFailure: true });
    for (const unit of bridgeUnits) sudo(['/usr/bin/systemctl', 'stop', unit.name], { allowFailure: true });
    try { await hub?.close(); } catch {}
    for (const unit of [...runtimeUnits, ...bridgeUnits]) sudo(['/usr/bin/rm', '--force', unit.installed], { allowFailure: true });
    sudo(['/usr/bin/systemctl', 'daemon-reload'], { allowFailure: true });
    for (const unit of [...runtimeUnits, ...bridgeUnits]) sudo(['/usr/bin/systemctl', 'reset-failed', unit.name], { allowFailure: true });
    for (const runtimeKey of [...RUNTIMES].reverse()) {
      const account = accounts.find(value => value.runtimeKey === runtimeKey) || partialAccount(runtimeKey);
      const suffix = opaqueRuntimeSuffix(runtimeKey);
      if (account) removeAccount(account);
      else {
        sudo(['/usr/bin/rm', '--recursive', '--force', '--one-file-system', path.join(HOST_TENANT_ROOT, suffix)], { allowFailure: true });
        sudo(['/usr/bin/rm', '--recursive', '--force', '--one-file-system', path.join(HOST_BRIDGE_ROOT, suffix)], { allowFailure: true });
      }
    }
    try {
      await waitFor(() => accounts.every(account => !lexists(`/run/user/${account.uid}`)), 10_000);
    } catch {
      fail('fixture_cleanup_failed', 'runtime_directory_cleanup_timeout');
    }
    if (archiveRoot) {
      const rootInfo = fs.lstatSync(archiveRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.geteuid()
          || rootInfo.gid !== process.getegid() || (rootInfo.mode & 0o7777) !== 0o711
          || fs.realpathSync(archiveRoot) !== archiveRoot
          || archiveRootIdentity && (rootInfo.dev !== archiveRootIdentity.dev || rootInfo.ino !== archiveRootIdentity.ino)) {
        fail('fixture_cleanup_failed', 'unsafe_archive_root');
      }
      if (archive && lexists(archive)) {
        const fileInfo = fs.lstatSync(archive);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1
            || fileInfo.uid !== process.geteuid() || fileInfo.gid !== process.getegid()
            || fs.realpathSync(archive) !== archive
            || archiveIdentity && (fileInfo.dev !== archiveIdentity.dev || fileInfo.ino !== archiveIdentity.ino)) {
          fail('fixture_cleanup_failed', 'unsafe_archive_file');
        }
        fs.unlinkSync(archive);
      }
      fs.rmdirSync(archiveRoot);
    }
    if (bridgeArtifactCreated) {
      const artifactInfo = fs.lstatSync(bridgeArtifactRoot);
      if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink() || artifactInfo.uid !== 0 || artifactInfo.gid !== 0
          || (artifactInfo.mode & 0o7777) !== 0o555 || fs.realpathSync(bridgeArtifactRoot) !== bridgeArtifactRoot
          || bridgeArtifactIdentity && (artifactInfo.dev !== bridgeArtifactIdentity.dev || artifactInfo.ino !== bridgeArtifactIdentity.ino)) {
        fail('fixture_cleanup_failed', 'unsafe_bridge_artifact');
      }
      sudo(['/usr/bin/rm', '--recursive', '--force', '--one-file-system', bridgeArtifactRoot]);
      if (lexists(bridgeArtifactRoot)) fail('fixture_cleanup_failed', 'bridge_artifact_remaining');
    }
    if (centralRoot) fs.rmSync(centralRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    for (const root of [...createdHostRoots].reverse()) {
      if (sudo(['/usr/bin/rmdir', root], { allowFailure: true }).status !== 0) fail('fixture_cleanup_failed');
    }
    const after = referenceSnapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('reference_service_changed');
    for (const runtimeKey of RUNTIMES) {
      const suffix = opaqueRuntimeSuffix(runtimeKey);
      const accountName = hostAccountName(runtimeKey);
      const priorAccount = accounts.find(value => value.runtimeKey === runtimeKey);
      if (accountExists(accountName) || run('/usr/bin/getent', ['group', accountName], { allowFailure: true }).status === 0
          || lexists(path.join(HOST_TENANT_ROOT, suffix))
          || lexists(path.join(HOST_BRIDGE_ROOT, suffix))
          || (priorAccount && lexists(`/run/user/${priorAccount.uid}`))
          || fs.readFileSync('/etc/subuid', 'utf8').split('\n').some(line => line.startsWith(`${accountName}:`))
          || fs.readFileSync('/etc/subgid', 'utf8').split('\n').some(line => line.startsWith(`${accountName}:`))
          || sudo(['/usr/bin/test', '!', '-e', `/var/lib/systemd/linger/${accountName}`], { allowFailure: true }).status !== 0
          || systemUnitExists(`dispatch-dsp-${suffix}.service`)
          || systemUnitExists(`dispatch-fixture-bridge-${suffix}.service`)) fail('fixture_cleanup_failed');
    }
  }
  return Object.freeze({
    ok: true,
    status: 'rootless_host_fixture_verified',
    accounts: 2,
    containers: 2,
    uniqueSubidRanges: true,
    lockedNonLoginAccounts: true,
    imageManifestVerified: true,
    resourceLimitsVerified: true,
    systemdSupervised: true,
    outboundAgentBridges: 2,
    bridgeRestartRecovery: true,
    crossedFilesystemDenied: true,
    crossedEngineDenied: true,
    crossedProcessDenied: true,
    crossedSocketDenied: true,
    browserSandbox: true,
    restartRecovery: true,
    referenceServicesUnchanged: true,
    artifactsRemaining: 0,
  });
}

async function main() {
  process.umask(0o077);
  if (process.geteuid() === 0 || run('/usr/bin/sudo', ['-n', 'true'], { allowFailure: true }).status !== 0) fail();
  if (sudo(['/usr/bin/mkdir', '--mode=0700', HOST_FIXTURE_LOCK], { allowFailure: true }).status !== 0) {
    fail('rootless_host_fixture_busy');
  }
  let receipt;
  try {
    const lock = fs.lstatSync(HOST_FIXTURE_LOCK);
    if (!lock.isDirectory() || lock.uid !== 0 || lock.gid !== 0 || (lock.mode & 0o7777) !== 0o700
        || fs.realpathSync(HOST_FIXTURE_LOCK) !== HOST_FIXTURE_LOCK) fail('unsafe_fixture_host_root');
    receipt = await runFixture();
  } finally {
    if (sudo(['/usr/bin/rmdir', HOST_FIXTURE_LOCK], { allowFailure: true }).status !== 0) {
      fail('fixture_cleanup_failed', 'fixture_lock_cleanup_failed');
    }
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    status: error?.code || 'rootless_host_fixture_failed',
    phase: error?.phase || currentPhase,
    diagnostic: String(error?.diagnostic || '').replace(/[A-Za-z0-9_-]{43}/g, '[redacted]'),
  })}\n`);
  process.exitCode = 1;
});

module.exports = { main };
