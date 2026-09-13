'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { registrationToken } = require('../../../shared/agent/protocol');
const { MANAGED_INSTALLATION_DIRECTORY_FIELDS } = require('../../../shared/paths/runtime-paths');
const { readRootFile } = require('./oci-host-artifact');
const { HOST_TENANT_ROOT, HOST_BRIDGE_ROOT } = require('../../runtime-host-identity');
const {
  validateOciDeploymentPlan,
  renderOciSystemUnit,
  renderOciBridgeSystemUnit,
} = require('./oci-deployment');

const MAX_OUTPUT = 128 * 1024;
const COMMANDS = Object.freeze({
  getent: '/usr/bin/getent',
  groupadd: '/usr/sbin/groupadd',
  groupdel: '/usr/sbin/groupdel',
  useradd: '/usr/sbin/useradd',
  usermod: '/usr/sbin/usermod',
  userdel: '/usr/sbin/userdel',
  passwd: '/usr/bin/passwd',
  loginctl: '/usr/bin/loginctl',
  systemctl: '/usr/bin/systemctl',
  systemdRun: '/usr/bin/systemd-run',
  systemdAnalyze: '/usr/bin/systemd-analyze',
  runuser: '/usr/sbin/runuser',
  env: '/usr/bin/env',
  podman: '/usr/bin/podman',
  install: '/usr/bin/install',
  cmp: '/usr/bin/cmp',
  dd: '/usr/bin/dd',
  rm: '/usr/bin/rm',
});

function fail(code = 'service_installation_failed') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required = allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail('runtime_boundary_violation');
  }
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail('runtime_boundary_violation');
  return value;
}

function lstatMaybe(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('runtime_boundary_violation');
  }
}

function sha256File(target, expectedUid = 0, expectedGid = 0, expectedMode = 0o444) {
  const before = lstatMaybe(target);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid
      || before.gid !== expectedGid || before.nlink !== 1 || (before.mode & 0o7777) !== expectedMode
      || fs.realpathSync(target) !== target) fail('runtime_boundary_violation');
  const handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(handle);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    const after = fs.fstatSync(handle);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || size !== opened.size) fail();
    return hash.digest('hex');
  } finally { fs.closeSync(handle); }
}

function guarded(capability, callback) {
  if (typeof capability !== 'function') fail('runtime_boundary_violation');
  return capability(callback);
}

function defaultExecute(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input: options.input,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeout: options.timeout || 120_000,
    maxBuffer: MAX_OUTPUT,
  });
  if (result.error || result.signal || !(options.accepted || [0]).includes(result.status)
      || Buffer.byteLength(result.stdout || '', 'utf8') > MAX_OUTPUT
      || Buffer.byteLength(result.stderr || '', 'utf8') > MAX_OUTPUT) fail(options.code);
  return result;
}

function createOciHostExecutor(options) {
  exact(options, [
    'registry', 'stateRoot', 'unitRoot', 'releaseRoot', 'centralSocket', 'centralUid',
    'controllerUid', 'execute', 'clock', 'remainingMs',
  ], ['registry', 'stateRoot', 'unitRoot', 'releaseRoot', 'centralSocket', 'centralUid', 'controllerUid']);
  const registry = options.registry;
  if (!registry || ['reserve', 'inspect', 'activate', 'retire'].some(method => typeof registry[method] !== 'function')) {
    fail('runtime_boundary_violation');
  }
  const stateRoot = absolute(options.stateRoot);
  const unitRoot = absolute(options.unitRoot);
  if (unitRoot !== '/etc/systemd/system') fail('runtime_boundary_violation');
  const releaseRoot = absolute(options.releaseRoot);
  const centralSocket = absolute(options.centralSocket);
  const centralUid = options.centralUid;
  const controllerUid = options.controllerUid;
  const execute = options.execute || defaultExecute;
  const clock = options.clock || Date.now;
  const remainingMs = options.remainingMs;
  if (remainingMs !== undefined && typeof remainingMs !== 'function') fail('runtime_boundary_violation');
  if (!Number.isSafeInteger(centralUid) || centralUid < 1 || controllerUid !== 0
      || centralUid === controllerUid || typeof execute !== 'function' || typeof clock !== 'function') {
    fail('runtime_boundary_violation');
  }
  for (const [root, mode] of [[stateRoot, 0o700], [unitRoot, 0o755], [releaseRoot, 0o755]]) {
    const info = lstatMaybe(root);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
        || (info.mode & 0o7777) !== mode || fs.realpathSync(root) !== root) fail('runtime_boundary_violation');
  }
  for (const [root, mode] of [[HOST_TENANT_ROOT, 0o755], [HOST_BRIDGE_ROOT, 0o711]]) {
    const info = lstatMaybe(root);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
        || (info.mode & 0o7777) !== mode || fs.realpathSync(root) !== root) fail('runtime_boundary_violation');
  }
  const candidatesRoot = path.join(stateRoot, 'candidates');
  const journalsRoot = path.join(stateRoot, 'journals');
  for (const root of [candidatesRoot, journalsRoot]) {
    try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const info = lstatMaybe(root);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
        || (info.mode & 0o7777) !== 0o700 || fs.realpathSync(root) !== root) fail('runtime_boundary_violation');
  }

  function command(executable, args, settings = {}) {
    if (!Object.values(COMMANDS).includes(executable) || !Array.isArray(args)
        || args.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) {
      fail('runtime_boundary_violation');
    }
    if (remainingMs !== undefined) {
      const remaining = remainingMs();
      if (!Number.isSafeInteger(remaining) || remaining < 1) fail('runtime_boundary_violation');
      return execute(executable, args, { ...settings, timeout: Math.min(settings.timeout || 120_000, remaining) });
    }
    return execute(executable, args, settings);
  }

  function runAs(plan, executable, args, settings = {}) {
    const environment = [
      `HOME=${plan.host.accountHome}`,
      `XDG_DATA_HOME=${plan.host.engineDataRoot}`,
      `XDG_CONFIG_HOME=${plan.host.engineConfigRoot}`,
      `XDG_RUNTIME_DIR=/run/user/${plan.account.uid}`,
      'PATH=/usr/bin:/bin',
      'LANG=C.UTF-8',
      'LC_ALL=C.UTF-8',
    ];
    return command(COMMANDS.runuser, [
      '--user', plan.account.name, '--', COMMANDS.env, '-i', ...environment, executable, ...args,
    ], settings);
  }

  function selectedPlan(value, statuses = ['reserved', 'active']) {
    const plan = validateOciDeploymentPlan(value);
    const allocation = registry.inspect(plan.runtimeKey);
    if (!allocation || !statuses.includes(allocation.status)
        || JSON.stringify({
          name: allocation.name, uid: allocation.uid, gid: allocation.gid,
          subuidStart: allocation.subuidStart, subgidStart: allocation.subgidStart,
          subidCount: allocation.subidCount,
        }) !== JSON.stringify(plan.account)) fail('runtime_identity_mismatch');
    return plan;
  }

  function receipt(plan, status, changed = false) {
    return Object.freeze({
      backend: plan.backend,
      planVersion: plan.version,
      planDigest: plan.planDigest,
      status,
      changed,
    });
  }

  function passwd(name) {
    const result = command(COMMANDS.getent, ['passwd', name], { accepted: [0, 2] });
    return result.status === 0 ? result.stdout.trim().split(':') : null;
  }

  function group(name) {
    const result = command(COMMANDS.getent, ['group', name], { accepted: [0, 2] });
    return result.status === 0 ? result.stdout.trim().split(':') : null;
  }

  function exactSubid(file, name, start, count) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.startsWith(`${name}:`));
    if (lines.length === 0) return false;
    if (lines.length !== 1 || lines[0] !== `${name}:${start}:${count}`) fail('runtime_boundary_violation');
    return true;
  }

  function safeDirectory(target, uid, gid, mode) {
    const info = lstatMaybe(target);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.gid !== gid
        || (info.mode & 0o7777) !== mode || fs.realpathSync(target) !== target) fail('runtime_boundary_violation');
  }

  function installDirectory(target, uid, gid, mode, mutationCapability, plan) {
    const current = lstatMaybe(target);
    if (!current) {
      if (plan && uid === plan.account.uid && target !== plan.host.tenantRoot) {
        // Tenant-controlled descendants must never be traversed by a privileged
        // mkdir/chown. A symlink race is confined to the tenant's own privileges.
        guarded(mutationCapability, () => runAs(plan, COMMANDS.install, [
          '-d', '-m', mode.toString(8).padStart(4, '0'), target,
        ]));
      } else {
        const parent = path.dirname(target);
        if (parent !== HOST_TENANT_ROOT && parent !== HOST_BRIDGE_ROOT) fail('runtime_boundary_violation');
        safeDirectory(parent, 0, 0, parent === HOST_TENANT_ROOT ? 0o755 : 0o711);
        guarded(mutationCapability, () => command(COMMANDS.install, [
          '-d', '-o', String(uid), '-g', String(gid), '-m', mode.toString(8).padStart(4, '0'), target,
        ]));
      }
    }
    else if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== uid
        || current.gid !== gid || fs.realpathSync(target) !== target) fail('runtime_boundary_violation');
    else if ((current.mode & 0o7777) !== mode) fail('runtime_boundary_violation');
    safeDirectory(target, uid, gid, mode);
  }

  function prepareAccount(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    let changed = false;
    let selectedGroup = group(plan.account.name);
    let selectedPasswd = passwd(plan.account.name);
    if (selectedGroup && Number(selectedGroup[2]) !== plan.account.gid
        || selectedPasswd && (Number(selectedPasswd[2]) !== plan.account.uid
          || Number(selectedPasswd[3]) !== plan.account.gid || selectedPasswd[5] !== plan.host.accountHome
          || selectedPasswd[6] !== '/usr/sbin/nologin')) fail('runtime_identity_mismatch');
    if (!selectedGroup) {
      guarded(mutationCapability, () => command(COMMANDS.groupadd, [
        '--system', '--gid', String(plan.account.gid), plan.account.name,
      ]));
      selectedGroup = group(plan.account.name);
      changed = true;
    }
    if (!selectedGroup || Number(selectedGroup[2]) !== plan.account.gid) fail('runtime_identity_mismatch');
    if (!selectedPasswd) {
      guarded(mutationCapability, () => command(COMMANDS.useradd, [
        '--system', '--uid', String(plan.account.uid), '--gid', String(plan.account.gid),
        '--home-dir', plan.host.accountHome, '--no-create-home', '--shell', '/usr/sbin/nologin',
        plan.account.name,
      ]));
      selectedPasswd = passwd(plan.account.name);
      changed = true;
    }
    if (!selectedPasswd || Number(selectedPasswd[2]) !== plan.account.uid
        || Number(selectedPasswd[3]) !== plan.account.gid || selectedPasswd[5] !== plan.host.accountHome
        || selectedPasswd[6] !== '/usr/sbin/nologin') fail('runtime_identity_mismatch');
    const password = command(COMMANDS.passwd, ['--status', plan.account.name]).stdout.trim().split(/\s+/);
    if (password[0] !== plan.account.name || password[1] !== 'L') {
      guarded(mutationCapability, () => command(COMMANDS.passwd, ['--lock', plan.account.name]));
      changed = true;
    }
    for (const [file, start, flag] of (plan.backend === 'native_service_v1' ? [] : [
      ['/etc/subuid', plan.account.subuidStart, '--add-subuids'],
      ['/etc/subgid', plan.account.subgidStart, '--add-subgids'],
    ])) {
      if (!exactSubid(file, plan.account.name, start, plan.account.subidCount)) {
        guarded(mutationCapability, () => command(COMMANDS.usermod, [
          flag, `${start}-${start + plan.account.subidCount - 1}`, plan.account.name,
        ]));
        if (!exactSubid(file, plan.account.name, start, plan.account.subidCount)) fail();
        changed = true;
      }
    }
    for (const root of [plan.host.tenantRoot, plan.host.accountHome,
      ...(plan.backend === 'native_service_v1' ? [] : [plan.host.engineDataRoot, plan.host.engineConfigRoot]),
      path.dirname(plan.host.installationRoot)]) {
      installDirectory(root, plan.account.uid, plan.account.gid, 0o700, mutationCapability, plan);
    }
    installDirectory(plan.host.bridgeRoot, 0, 0, 0o711, mutationCapability);
    if (plan.backend !== 'native_service_v1') {
    guarded(mutationCapability, () => command(COMMANDS.loginctl, ['enable-linger', plan.account.name]));
    guarded(mutationCapability, () => command(COMMANDS.systemctl, ['start', `user@${plan.account.uid}.service`]));
    const runtimeRoot = `/run/user/${plan.account.uid}`;
    safeDirectory(runtimeRoot, plan.account.uid, plan.account.gid, 0o700);
    }
    if (registry.inspect(plan.runtimeKey).status === 'reserved') guarded(mutationCapability, () => registry.activate(plan.runtimeKey));
    return receipt(plan, 'account_ready', changed);
  }

  function materializeLayout(planValue, tokenValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    if (registry.inspect(plan.runtimeKey).status !== 'active') fail('runtime_boundary_violation');
    const token = registrationToken(tokenValue);
    installDirectory(plan.host.installationRoot, plan.account.uid, plan.account.gid, 0o700, mutationCapability, plan);
    const roots = Object.values(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
      .map(relative => path.join(plan.host.installationRoot, relative))
      .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
    for (const root of roots) installDirectory(root, plan.account.uid, plan.account.gid, 0o700, mutationCapability, plan);
    const target = path.join(plan.host.installationRoot, 'secrets', 'runtime-agent', 'registration-token');
    const current = lstatMaybe(target);
    if (current) {
      if (!current.isFile() || current.isSymbolicLink() || current.uid !== plan.account.uid
          || current.gid !== plan.account.gid || current.nlink !== 1 || (current.mode & 0o7777) !== 0o600
          || fs.realpathSync(target) !== target
          || runAs(plan, COMMANDS.cmp, ['--silent', target, '-'], {
            input: `${token}\n`, accepted: [0, 1],
          }).status !== 0) fail('runtime_identity_mismatch');
      return receipt(plan, 'layout_ready');
    }
    guarded(mutationCapability, () => runAs(plan, COMMANDS.dd, [`of=${target}`, 'conv=excl,fsync', 'oflag=nofollow', 'status=none'], {
      input: `${token}\n`,
    }));
    materializeLayout(plan, token, mutationCapability);
    return receipt(plan, 'layout_ready', true);
  }

  function releaseDirectory(plan) {
    const root = path.join(releaseRoot, plan.release.releaseId);
    if (path.dirname(root) !== releaseRoot) fail('runtime_boundary_violation');
    safeDirectory(root, 0, 0, 0o555);
    return root;
  }

  function verifyBridgeArtifact(plan) {
    const root = path.join(releaseDirectory(plan), 'bridge-artifact');
    safeDirectory(root, 0, 0, 0o555);
    const manifestFile = path.join(root, 'manifest.json');
    if (sha256File(manifestFile) !== plan.release.bridgeManifestSha256) fail('runtime_identity_mismatch');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { fail('runtime_boundary_violation'); }
    if (!plain(manifest) || Object.keys(manifest).sort().join(',') !== 'files,version'
        || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1) fail();
    const expected = [];
    for (const entry of manifest.files) {
      if (!plain(entry) || Object.keys(entry).sort().join(',') !== 'path,sha256'
          || typeof entry.path !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(entry.path)
          || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail();
      const target = path.join(root, entry.path);
      if (path.relative(root, target) !== entry.path || sha256File(target) !== entry.sha256) fail('runtime_identity_mismatch');
      expected.push(entry.path);
    }
    if (JSON.stringify([...expected].sort()) !== JSON.stringify(expected)) fail();
    const actual = [];
    const actualDirectories = [];
    function walk(directory, relative = '') {
      safeDirectory(directory, 0, 0, 0o555);
      for (const name of fs.readdirSync(directory).sort()) {
        const target = path.join(directory, name);
        const child = relative ? `${relative}/${name}` : name;
        if (child === 'manifest.json') continue;
        const info = lstatMaybe(target);
        if (!info || info.isSymbolicLink()) fail();
        if (info.isDirectory()) { actualDirectories.push(child); walk(target, child); }
        else if (info.isFile()) actual.push(child);
        else fail();
      }
    }
    walk(root);
    const expectedDirectories = [...new Set(expected.flatMap(file => {
      const segments = file.split('/');
      return segments.slice(0, -1).map((unused, index) => segments.slice(0, index + 1).join('/'));
    }))].sort();
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)
        || JSON.stringify(actualDirectories.sort()) !== JSON.stringify(expectedDirectories)) {
      fail('runtime_identity_mismatch');
    }
    return root;
  }

  function bridgeExecutable(plan) {
    const selected = path.join(
      verifyBridgeArtifact(plan), 'core', 'agent-bridge', 'src', 'service-cli.js',
    );
    if (!lstatMaybe(selected)) fail();
    return selected;
  }

  function inspectImage(plan) {
    if (plan.backend === 'native_service_v1') return require('./native-runtime-artifact').verifyNativeRuntime(
      path.join(releaseDirectory(plan), 'runtime-artifact'), plan.release);
    const result = runAs(plan, COMMANDS.podman, ['image', 'inspect', plan.release.image], { accepted: [0, 125] });
    if (result.status !== 0) return null;
    let selected;
    try { selected = JSON.parse(result.stdout)[0]; } catch { fail(); }
    const selectedId = String(selected?.Id || '').replace(/^sha256:/, '');
    if (selectedId !== plan.release.imageId || selected?.Digest !== plan.release.imageDigest
        || selected?.Architecture !== 'amd64' || selected?.Os !== 'linux'
        || selected?.Config?.User !== '10001:10001'
        || !(selected.RepoDigests || []).includes(plan.release.image)
        || selected?.Labels?.['org.opencontainers.image.revision'] !== plan.release.sourceCommit) {
      fail('runtime_identity_mismatch');
    }
    return selected;
  }

  function ensureRuntimeManager(plan, mutationCapability) {
    if (plan.backend === 'native_service_v1') return;
    const runtimeRoot = `/run/user/${plan.account.uid}`;
    if (!lstatMaybe(runtimeRoot)) {
      const entry = passwd(plan.account.name);
      if (!entry || Number(entry[2]) !== plan.account.uid || Number(entry[3]) !== plan.account.gid
          || entry[5] !== plan.host.accountHome || entry[6] !== '/usr/sbin/nologin') fail('runtime_identity_mismatch');
      guarded(mutationCapability, () => command(COMMANDS.systemctl, ['start', `user@${plan.account.uid}.service`]));
    }
    safeDirectory(runtimeRoot, plan.account.uid, plan.account.gid, 0o700);
  }

  function prepareImage(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    if (plan.backend === 'native_service_v1') {
      inspectImage(plan);
      return receipt(plan, 'image_ready');
    }
    ensureRuntimeManager(plan, mutationCapability);
    let step = 'image_inspect';
    try {
    const attestManifest = () => {
      step = 'manifest_attestation';
      const manifest = guarded(mutationCapability, () => runAs(plan, COMMANDS.podman, [
        'run', '--rm', '--name', `${plan.identity.containerName}-manifest`,
        '--pull=never', '--network=none', '--read-only',
        '--entrypoint', '/usr/bin/sha256sum', plan.release.image,
        '/opt/dispatch/runtime-release-manifest.json',
      ], { timeout: 120_000 }));
      if (manifest.stdout.trim().split(/\s+/)[0] !== plan.release.embeddedManifestSha256) {
        fail('runtime_identity_mismatch');
      }
    };
    if (inspectImage(plan)) { attestManifest(); return receipt(plan, 'image_ready'); }
    const archive = path.join(releaseDirectory(plan), 'runtime-image.tar');
    const info = lstatMaybe(archive);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
        || info.nlink !== 1 || (info.mode & 0o7777) !== 0o444 || fs.realpathSync(archive) !== archive) fail();
    if (sha256File(archive) !== plan.release.imageArchiveSha256) fail('runtime_identity_mismatch');
    step = 'image_load';
    guarded(mutationCapability, () => runAs(plan, COMMANDS.podman, [
      'load', '--quiet', '--input', archive,
    ], { timeout: 600_000 }));
    step = 'loaded_image_inspect';
    if (!inspectImage(plan)) fail('runtime_identity_mismatch');
    attestManifest();
    return receipt(plan, 'image_ready', true);
    } catch (error) { error.hostStep = step; throw error; }
  }

  function candidatePaths(plan) {
    return Object.freeze({
      runtime: path.join(candidatesRoot, plan.identity.unitName),
      bridge: path.join(candidatesRoot, plan.identity.bridgeUnitName),
      journal: path.join(journalsRoot, `${plan.identity.suffix}.json`),
      settled: path.join(journalsRoot, `${plan.identity.suffix}.settled.json`),
    });
  }

  function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  function durableWrite(file, content, mode) {
    const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  }

  function unitContent(plan, name) {
    return name === plan.identity.unitName ? renderOciSystemUnit(plan) : renderOciBridgeSystemUnit(plan, {
      bridgeExecutable: path.join(releaseRoot, plan.release.releaseId, 'bridge-artifact',
        'core/agent-bridge/src/service-cli.js'), centralSocket, centralUid, controllerUid,
    });
  }

  function attestUnit(plan, name, allowAbsent = false, expectedContent = null, recoveryGuard = null) {
    const target = path.join(unitRoot, name);
    const state = unitState(name);
    if (allowAbsent && !lstatMaybe(target) && state.LoadState === 'not-found'
        && state.ActiveState === 'inactive' && !state.Job) return state;
    if (allowAbsent && recoveryGuard && !lstatMaybe(target)
        && state.LoadState === 'loaded' && state.FragmentPath === target
        && ['inactive', 'failed'].includes(state.ActiveState) && state.MainPID === '0'
        && !state.Job && !state.DropInPaths) {
      // The root journal authorizes this interrupted unlink. Reload only after
      // proving the cached unit cannot still execute, then attest absence.
      guarded(recoveryGuard, () => command(COMMANDS.systemctl, ['daemon-reload']));
      return attestUnit(plan, name, true, expectedContent);
    }
    const content = readRootFile(target, 0o644, 64 * 1024).toString('utf8');
    if (content !== (expectedContent === null ? unitContent(plan, name) : expectedContent)
        || state.LoadState !== 'loaded' || state.FragmentPath !== target
        || state.DropInPaths || state.Job) fail('runtime_identity_mismatch');
    if (state.NeedDaemonReload !== 'no') {
      if (!recoveryGuard || state.NeedDaemonReload !== 'yes') fail('runtime_identity_mismatch');
      guarded(recoveryGuard, () => command(COMMANDS.systemctl, ['daemon-reload']));
      return attestUnit(plan, name, allowAbsent, expectedContent);
    }
    return state;
  }

  function writeExact(file, content, mode, mutationCapability) {
    const current = lstatMaybe(file);
    if (current && (!current.isFile() || current.isSymbolicLink() || current.uid !== process.geteuid()
        || current.nlink !== 1 || (current.mode & 0o7777) !== mode || fs.readFileSync(file, 'utf8') !== content)) fail();
    if (current) return false;
    guarded(mutationCapability, () => durableWrite(file, content, mode));
    return true;
  }

  function render(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    prepareImage(plan, mutationCapability);
    const paths = candidatePaths(plan);
    const runtime = renderOciSystemUnit(plan);
    const bridge = renderOciBridgeSystemUnit(plan, {
      bridgeExecutable: bridgeExecutable(plan), centralSocket, centralUid, controllerUid,
    });
    const runtimeChanged = writeExact(paths.runtime, runtime, 0o600, mutationCapability);
    const bridgeChanged = writeExact(paths.bridge, bridge, 0o600, mutationCapability);
    const changed = runtimeChanged || bridgeChanged;
    return receipt(plan, 'rendered', changed);
  }

  function validate(planValue) {
    const plan = selectedPlan(planValue);
    const paths = candidatePaths(plan);
    command(COMMANDS.systemdAnalyze, ['verify', paths.runtime, paths.bridge]);
    return receipt(plan, 'validated');
  }

  function unitState(name) {
    const result = command(COMMANDS.systemctl, [
      'show', name, '--property=LoadState,ActiveState,SubState,MainPID,NRestarts,FragmentPath,UnitFileState,User,Group,DropInPaths,NeedDaemonReload,Job',
    ], { accepted: [0, 1] });
    const values = {};
    for (const line of result.stdout.trimEnd().split('\n')) {
      const split = line.indexOf('=');
      if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
    }
    return Object.freeze(values);
  }

  function journal(plan, mutationCapability) {
    const paths = candidatePaths(plan);
    const existing = rollbackState(plan);
    if (existing) return existing;
    const settled = lstatMaybe(paths.settled)
      ? selectedPlan(JSON.parse(readRootFile(paths.settled, 0o600, 128 * 1024))) : null;
    const units = [plan.identity.bridgeUnitName, plan.identity.unitName].map(name => {
      const installed = path.join(unitRoot, name);
      const info = lstatMaybe(installed);
      const state = attestUnit(settled || plan, name, !info);
      if (!['active', 'inactive'].includes(state.ActiveState)
          || !['running', 'dead'].includes(state.SubState)
          || !['enabled', 'enabled-runtime', 'disabled', ''].includes(state.UnitFileState)) fail();
      return { name, existed: Boolean(info),
        content: info ? readRootFile(installed, 0o644, 64 * 1024).toString('base64') : null,
        active: state.ActiveState === 'active', enabled: state.UnitFileState || 'not-found' };
    });
    const value = { version: 2, planDigest: plan.planDigest, units };
    guarded(mutationCapability, () => durableWrite(paths.journal, `${JSON.stringify(value)}\n`, 0o600));
    return value;
  }

  function install(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    validate(plan);
    journal(plan, mutationCapability);
    const paths = candidatePaths(plan);
    for (const [name, candidate] of [[plan.identity.bridgeUnitName, paths.bridge], [plan.identity.unitName, paths.runtime]]) {
      const target = path.join(unitRoot, name);
      const content = fs.readFileSync(candidate);
      guarded(mutationCapability, () => durableWrite(target, content, 0o644));
      const info = lstatMaybe(target);
      if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
          || info.nlink !== 1 || (info.mode & 0o7777) !== 0o644 || !fs.readFileSync(target).equals(content)) fail();
    }
    guarded(mutationCapability, () => command(COMMANDS.systemctl, ['daemon-reload']));
    return receipt(plan, 'installed', true);
  }

  function setActive(planValue, active, mutationCapability) {
    const plan = selectedPlan(planValue);
    if (active) ensureRuntimeManager(plan, mutationCapability);
    const ordered = active
      ? [plan.identity.bridgeUnitName, plan.identity.unitName]
      : [plan.identity.unitName, plan.identity.bridgeUnitName];
    for (const name of ordered) {
      // A stopped target may already have prior definitions during rollback.
      const prior = active ? null : rollbackState(plan);
      const saved = prior?.units.find(unit => unit.name === name);
      const current = lstatMaybe(path.join(unitRoot, name));
      let expected = unitContent(plan, name);
      if (saved?.existed && current && fs.readFileSync(path.join(unitRoot, name), 'utf8')
          === Buffer.from(saved.content, 'base64').toString('utf8')) expected = Buffer.from(saved.content, 'base64').toString('utf8');
      const state = attestUnit(plan, name, !active, expected, !active && prior ? mutationCapability : null);
      if (state.LoadState === 'not-found') continue;
      guarded(mutationCapability, () => command(COMMANDS.systemctl,
        active ? ['enable', '--now', name] : plan.backend === 'native_service_v1' ? ['disable', '--now', name] : ['stop', name]));
    }
    return receipt(plan, active ? 'started' : 'stopped', true);
  }

  function start(plan, mutationCapability) { return setActive(plan, true, mutationCapability); }
  function stop(plan, mutationCapability) { return setActive(plan, false, mutationCapability); }

  function disable(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    const before = [plan.identity.unitName, plan.identity.bridgeUnitName].map(name => attestUnit(plan, name));
    guarded(mutationCapability, () => {
      for (const unit of [plan.identity.unitName, plan.identity.bridgeUnitName]) {
        command(COMMANDS.systemctl, ['disable', unit], { accepted: [0, 1] });
      }
    });
    const after = [plan.identity.unitName, plan.identity.bridgeUnitName].map(unitState);
    if (after.some(state => ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'].includes(state.UnitFileState))) {
      fail('service_installation_failed');
    }
    return receipt(plan, 'disabled', before.some(state =>
      ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'].includes(state.UnitFileState)));
  }

  function inspectState(planValue, expectedActive) {
    const plan = selectedPlan(planValue);
    if (typeof expectedActive !== 'boolean') fail('runtime_boundary_violation');
    for (const [name, expectedUser] of [[plan.identity.bridgeUnitName, '0'], [plan.identity.unitName, plan.account.name]]) {
      const state = attestUnit(plan, name);
      const installed = path.join(unitRoot, name);
      const active = state.ActiveState === 'active' && state.SubState === 'running' && /^[1-9][0-9]*$/.test(state.MainPID);
      const inactive = ['inactive', 'failed'].includes(state.ActiveState) && state.MainPID === '0';
      if (state.LoadState !== 'loaded' || state.FragmentPath !== installed || state.User !== expectedUser
          || expectedActive && !active || !expectedActive && !inactive) fail('runtime_health_failed');
    }
    if (expectedActive && !inspectImage(plan)) fail('runtime_identity_mismatch');
    return receipt(plan, expectedActive ? 'active' : 'inactive');
  }

  function inspect(planValue) {
    return inspectState(planValue, true);
  }

  function healthOnce(planValue) {
    const plan = selectedPlan(planValue);
    inspect(plan);
    if (plan.backend === 'native_service_v1') {
      const result = nativeProbe(plan, 'health');
      if (result.status !== 0) fail('runtime_health_failed');
      return receipt(plan, 'healthy');
    }
    const inspected = runAs(plan, COMMANDS.podman, ['container', 'inspect', plan.identity.containerName]);
    let container;
    try { container = JSON.parse(inspected.stdout)[0]; } catch { fail('runtime_health_failed'); }
    if (String(container?.Image || '').replace(/^sha256:/, '') !== plan.release.imageId
        || container?.Name !== plan.identity.containerName
        || container?.Config?.User !== plan.security.user
        || container?.Config?.Labels?.['io.dispatch.runtime-key'] !== plan.runtimeKey
        || container?.Config?.Labels?.['io.dispatch.release-id'] !== plan.release.releaseId
        || container?.Config?.Labels?.['io.dispatch.plan-digest'] !== plan.planDigest) fail('runtime_identity_mismatch');
    if (container?.State?.Running !== true) fail('runtime_health_failed');
    const result = runAs(plan, COMMANDS.podman, ['exec', plan.identity.containerName, '/usr/local/bin/node', '--no-warnings',
      '/opt/dispatch/runtime/supervisor/src/health.js'], {
      accepted: [0, 1, 125], timeout: 60_000,
    });
    if (result.status !== 0) fail('runtime_health_failed');
    return receipt(plan, 'healthy');
  }

  function verifyPublication(planValue, payload, mutationCapability) {
    const plan = selectedPlan(planValue);
    if (!payload || !['capture', 'verify'].includes(payload.mode)) fail('runtime_boundary_violation');
    exact(payload, payload.mode === 'capture' ? ['mode'] : ['mode', 'baseline']);
    const { publicationBaseline } = require('../../../shared/contracts/src/publication-baseline');
    if (payload.mode === 'verify') publicationBaseline(payload.baseline);
    const input = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(input) > 8192) fail('runtime_boundary_violation');
    const executable = ['/usr/local/bin/node', '--no-warnings', '/opt/dispatch/plugins/paycom/backend/bin/dispatch-paycom-publication-continuity'];
    let result;
    if (plan.backend === 'native_service_v1') {
      // Capture runs stopped; verification also runs after resume/start.
      // Suspended upgrades remain stopped. Attest both units in the observed state.
      const active = payload.mode === 'verify' && unitState(plan.identity.unitName).ActiveState === 'active';
      inspectState(plan, active);
      result = guarded(mutationCapability, () => nativeProbe(plan, 'publication', input));
    } else if (payload.mode === 'capture') {
      inspectState(plan, false);
      ensureRuntimeManager(plan, mutationCapability);
      // Recovery may have stopped a missing runtime-dir before Podman could
      // remove its persisted probe record. Only this reserved probe name is
      // reconciled under the fresh capture action.
      guarded(mutationCapability, () => runAs(plan, COMMANDS.podman,
        ['rm', '--force', '--ignore', `${plan.identity.containerName}-publication`], { code: 'first_publication_failed' }));
      result = guarded(mutationCapability, () => runAs(plan, COMMANDS.podman, [
        'run', '--rm', '-i', '--name', `${plan.identity.containerName}-publication`, '--pull=never',
        '--network=none', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges',
        '--user=10001:10001', '--userns=keep-id:uid=10001,gid=10001',
        '--memory=256m', '--cpus=1', '--pids-limit=32',
        '--mount', `type=bind,src=${plan.host.installationRoot},dst=${plan.guest.installationRoot},ro=true`,
        ...Object.entries(plan.guest.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        '--entrypoint=/usr/local/bin/node', plan.release.image, ...executable.slice(1),
      ], { input, timeout: 60_000, code: 'first_publication_failed' }));
    } else result = runAs(plan, COMMANDS.podman, ['exec', '-i', plan.identity.containerName, ...executable],
      { input, timeout: 60_000, code: 'first_publication_failed' });
    let value;
    try { value = JSON.parse(result.stdout); } catch { fail('first_publication_failed'); }
    if (payload.mode === 'capture') {
      exact(value, ['status', 'publicationBaseline']);
      if (value.status !== 'verified') fail('first_publication_failed');
      return Object.freeze({ status: 'verified', publicationBaseline: publicationBaseline(value.publicationBaseline) });
    }
    exact(value, ['status', 'publicationBaselineDigest']);
    if (value.status !== 'verified' || value.publicationBaselineDigest !== payload.baseline.digest) fail('first_publication_failed');
    return Object.freeze(value);
  }

  function nativeProbe(plan, operation, input = '') {
    if (plan.backend !== 'native_service_v1' || !['health', 'publication'].includes(operation)) fail('runtime_boundary_violation');
    const source = path.join(releaseDirectory(plan), 'runtime-artifact');
    const executable = operation === 'health' ? 'runtime/supervisor/src/health.js'
      : 'plugins/paycom/backend/bin/dispatch-paycom-publication-continuity';
    // A bounded one-shot process with the DSP's identity and read-only data.
    // No shell, arbitrary command, shared TCP port, or container engine.
    return command(COMMANDS.systemdRun, ['--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
      `--unit=dispatch-probe-${plan.identity.suffix}-${crypto.randomBytes(6).toString('hex')}`,
      ...[`User=${plan.account.name}`, `Group=${plan.account.name}`, 'UMask=0077', 'ProtectSystem=strict', 'ProtectHome=true',
        'NoNewPrivileges=true', 'PrivateNetwork=true', 'PrivateTmp=true', 'RuntimeMaxSec=60', 'MemoryMax=256M', 'TasksMax=32',
        `BindReadOnlyPaths=${source}:/opt/dispatch -${source}/dependencies/node/bin/host-files/usr/share/nodejs:/usr/share/nodejs ${plan.host.installationRoot}:${plan.guest.installationRoot} ${plan.host.bridgeRoot}:/run/dispatch-agent`,
        'WorkingDirectory=/opt/dispatch'].flatMap(value => ['--property', value]),
      ...Object.entries({ ...plan.guest.environment, PATH: '/opt/dispatch/dependencies/node/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' })
        .flatMap(([key, value]) => ['--setenv', `${key}=${value}`]),
      path.join(source, 'dependencies/node/bin/node'), '--no-warnings', `/opt/dispatch/${executable}`],
    { input, timeout: 65_000, code: operation === 'health' ? 'runtime_health_failed' : 'first_publication_failed' });
  }

  function health(planValue) {
    const deadline = clock() + Math.min(90_000, remainingMs ? remainingMs() : 90_000);
    for (;;) {
      try { return healthOnce(planValue); }
      catch (error) {
        if (['runtime_boundary_violation', 'runtime_identity_mismatch'].includes(error.code)
            || clock() + 1_000 >= deadline) throw error;
        if (remainingMs) remainingMs();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }
  }

  function rollbackState(planValue) {
    const plan = selectedPlan(planValue);
    const file = candidatePaths(plan).journal;
    const info = lstatMaybe(file);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid()
        || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) fail();
    const value = JSON.parse(readRootFile(file, 0o600, 192 * 1024));
    exact(value, ['version', 'planDigest', 'units']);
    if (value.version !== 2 || value.planDigest !== plan.planDigest || !Array.isArray(value.units)
        || value.units.length !== 2) fail();
    const names = [plan.identity.bridgeUnitName, plan.identity.unitName];
    for (const [index, unit] of value.units.entries()) {
      exact(unit, ['name', 'existed', 'content', 'active', 'enabled']);
      if (unit.name !== names[index] || typeof unit.existed !== 'boolean' || typeof unit.active !== 'boolean'
          || !['enabled', 'enabled-runtime', 'disabled', 'not-found'].includes(unit.enabled)
          || !unit.existed && (unit.content !== null || unit.active || unit.enabled !== 'not-found')
          || unit.existed && (typeof unit.content !== 'string' || unit.content.length > 88_000
            || Buffer.from(unit.content, 'base64').toString('base64') !== unit.content)) fail();
    }
    return Object.freeze(value);
  }

  function restorePrior(planValue, mutationCapability, activate = true) {
    const plan = selectedPlan(planValue);
    const prior = rollbackState(plan);
    if (!prior) return receipt(plan, 'restored');
    stop(plan, mutationCapability);
    for (const unit of prior.units) {
      const target = path.join(unitRoot, unit.name);
      guarded(mutationCapability, () => {
        if (unit.existed) durableWrite(target, Buffer.from(unit.content, 'base64'), 0o644);
        else { fs.rmSync(target, { force: true }); syncDirectory(unitRoot); }
      });
    }
    guarded(mutationCapability, () => command(COMMANDS.systemctl, ['daemon-reload']));
    for (const unit of prior.units) {
      guarded(mutationCapability, () => command(COMMANDS.systemctl, ['disable', unit.name], { accepted: [0, 1] }));
      guarded(mutationCapability, () => command(COMMANDS.systemctl, ['disable', '--runtime', unit.name], { accepted: [0, 1] }));
      if (['enabled', 'enabled-runtime'].includes(unit.enabled)) guarded(mutationCapability, () => command(COMMANDS.systemctl,
        unit.enabled === 'enabled-runtime' ? ['enable', '--runtime', unit.name] : ['enable', unit.name]));
      if (activate && unit.active) guarded(mutationCapability, () => command(COMMANDS.systemctl, ['start', unit.name]));
    }
    return receipt(plan, 'restored', true);
  }

  function settleCommitted(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    const paths = candidatePaths(plan);
    rollbackState(plan);
    for (const name of [plan.identity.bridgeUnitName, plan.identity.unitName]) attestUnit(plan, name);
    guarded(mutationCapability, () => {
      durableWrite(paths.settled, `${JSON.stringify(plan)}\n`, 0o600);
      fs.rmSync(paths.journal, { force: true });
      fs.rmSync(paths.runtime, { force: true });
      fs.rmSync(paths.bridge, { force: true });
      syncDirectory(journalsRoot); syncDirectory(candidatesRoot);
    });
    return receipt(plan, 'committed', true);
  }

  function commit(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    health(plan);
    // The following authoritative operation settles this journal only after
    // observing the completed prior job. Completion here remains reversible.
    return receipt(plan, 'committed', false);
  }

  function rollback(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    const changed = Boolean(rollbackState(plan));
    if (changed) restorePrior(plan, mutationCapability);
    const paths = candidatePaths(plan);
    guarded(mutationCapability, () => {
      fs.rmSync(paths.journal, { force: true });
      fs.rmSync(paths.runtime, { force: true });
      fs.rmSync(paths.bridge, { force: true });
      syncDirectory(journalsRoot); syncDirectory(candidatesRoot);
    });
    return receipt(plan, 'rolled_back', changed);
  }

  function priorPlanWithoutJournal(plan) {
    const file = candidatePaths(plan).settled;
    const prior = selectedPlan(JSON.parse(readRootFile(file, 0o600, 128 * 1024)));
    if (prior.runtimeKey !== plan.runtimeKey || prior.deployment.manifestRevision + 1 !== plan.deployment.manifestRevision) fail();
    return prior;
  }

  function rollbackStopped(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    const prior = rollbackState(plan);
    if (!prior) {
      // Installation cannot mutate unit files before its durable journal. With
      // no journal, only exact definitions from the settled prior release are
      // acceptable; this also handles failure during image/render preparation.
      const unchanged = priorPlanWithoutJournal(plan);
      stop(unchanged, mutationCapability);
      inspectState(unchanged, false);
      return receipt(plan, 'restored', false);
    }
    restorePrior(plan, mutationCapability, false);
    for (const unit of prior.units) {
      const state = attestUnit(plan, unit.name, !unit.existed, unit.existed ? Buffer.from(unit.content, 'base64').toString('utf8') : null);
      if (state.ActiveState !== 'inactive' || state.SubState !== 'dead'
          || (state.UnitFileState || 'not-found') !== unit.enabled) fail();
    }
    return receipt(plan, 'restored', true);
  }

  function startPrior(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    ensureRuntimeManager(plan, mutationCapability);
    const journal = rollbackState(plan);
    const unchanged = journal ? null : priorPlanWithoutJournal(plan);
    for (const name of [plan.identity.bridgeUnitName, plan.identity.unitName]) {
      const saved = journal?.units.find(unit => unit.name === name);
      if (saved && !saved.existed) fail();
      const state = attestUnit(unchanged || plan, name, false,
        saved ? Buffer.from(saved.content, 'base64').toString('utf8') : null);
      const enabled = saved?.enabled || state.UnitFileState;
      const native = plan.backend === 'native_service_v1';
      if (state.UnitFileState !== enabled && !(native && state.UnitFileState === 'enabled')) fail();
      guarded(mutationCapability, () => command(COMMANDS.systemctl, native ? ['enable', '--now', name] : ['start', name]));
      if (unitState(name).UnitFileState !== (native ? 'enabled' : enabled)) fail();
    }
    return receipt(plan, 'started', true);
  }

  function settleRollback(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    rollbackState(plan);
    const paths = candidatePaths(plan);
    guarded(mutationCapability, () => {
      fs.rmSync(paths.journal, { force: true });
      fs.rmSync(paths.runtime, { force: true });
      fs.rmSync(paths.bridge, { force: true });
      syncDirectory(journalsRoot); syncDirectory(candidatesRoot);
    });
    return receipt(plan, 'rolled_back', true);
  }

  function removeServices(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    journal(plan, mutationCapability);
    stop(plan, mutationCapability);
    for (const name of [plan.identity.unitName, plan.identity.bridgeUnitName]) {
      guarded(mutationCapability, () => command(COMMANDS.systemctl, ['disable', name], { accepted: [0, 1] }));
      guarded(mutationCapability, () => { fs.rmSync(path.join(unitRoot, name), { force: true }); syncDirectory(unitRoot); });
    }
    guarded(mutationCapability, () => command(COMMANDS.systemctl, ['daemon-reload']));
    return receipt(plan, 'removed', true);
  }

  function inspectRemoved(planValue) {
    const plan = selectedPlan(planValue);
    for (const name of [plan.identity.unitName, plan.identity.bridgeUnitName]) {
      if (lstatMaybe(path.join(unitRoot, name)) || unitState(name).LoadState !== 'not-found') {
        fail('decommission_failed');
      }
    }
    return receipt(plan, 'absent');
  }

  function settleRemoved(planValue, mutationCapability) {
    const plan = selectedPlan(planValue);
    inspectRemoved(plan);
    const paths = candidatePaths(plan);
    guarded(mutationCapability, () => {
      fs.rmSync(paths.journal, { force: true });
      fs.rmSync(paths.runtime, { force: true });
      fs.rmSync(paths.bridge, { force: true });
      syncDirectory(journalsRoot); syncDirectory(candidatesRoot);
    });
    return receipt(plan, 'retained', true);
  }

  function destroyAccount(planValue, mutationCapability) {
    const plan = selectedPlan(planValue, ['active', 'retired']);
    if (registry.inspect(plan.runtimeKey).status === 'retired') {
      verifyDestroyed(plan);
      return receipt(plan, 'destroyed');
    }
    const existingPasswd = passwd(plan.account.name);
    const existingGroup = group(plan.account.name);
    if (existingPasswd && (Number(existingPasswd[2]) !== plan.account.uid
        || Number(existingPasswd[3]) !== plan.account.gid || existingPasswd[5] !== plan.host.accountHome
        || existingPasswd[6] !== '/usr/sbin/nologin')
        || existingGroup && Number(existingGroup[2]) !== plan.account.gid) fail('runtime_identity_mismatch');
    const hasSubuid = exactSubid('/etc/subuid', plan.account.name, plan.account.subuidStart, plan.account.subidCount);
    const hasSubgid = exactSubid('/etc/subgid', plan.account.name, plan.account.subgidStart, plan.account.subidCount);
    if (!existingPasswd && (hasSubuid || hasSubgid)) fail('runtime_identity_mismatch');
    for (const name of [plan.identity.unitName, plan.identity.bridgeUnitName]) {
      const state = unitState(name);
      if (state.LoadState !== 'not-found') fail('destruction_failed');
    }
    if (existingPasswd && plan.backend !== 'native_service_v1') guarded(mutationCapability, () => runAs(plan, COMMANDS.podman, ['system', 'reset', '--force'], {
      accepted: [0, 125], timeout: 300_000,
    }));
    guarded(mutationCapability, () => command(COMMANDS.loginctl, ['disable-linger', plan.account.name], { accepted: [0, 1] }));
    guarded(mutationCapability, () => command(COMMANDS.systemctl, ['stop', `user@${plan.account.uid}.service`,
      `user-runtime-dir@${plan.account.uid}.service`], { accepted: [0, 1] }));
    if (existingPasswd && hasSubuid) guarded(mutationCapability, () => command(COMMANDS.usermod, [
      '--del-subuids', `${plan.account.subuidStart}-${plan.account.subuidStart + plan.account.subidCount - 1}`,
      plan.account.name,
    ], { accepted: [0, 6] }));
    if (existingPasswd && hasSubgid) guarded(mutationCapability, () => command(COMMANDS.usermod, [
      '--del-subgids', `${plan.account.subgidStart}-${plan.account.subgidStart + plan.account.subidCount - 1}`,
      plan.account.name,
    ], { accepted: [0, 6] }));
    if (existingPasswd) guarded(mutationCapability, () => command(COMMANDS.userdel, [plan.account.name]));
    if (group(plan.account.name)) guarded(mutationCapability, () => command(COMMANDS.groupdel, [plan.account.name], { accepted: [0, 6] }));
    guarded(mutationCapability, () => command(COMMANDS.rm, [
      '--recursive', '--force', '--one-file-system', plan.host.tenantRoot,
    ]));
    guarded(mutationCapability, () => command(COMMANDS.rm, [
      '--recursive', '--force', '--one-file-system', plan.host.bridgeRoot,
    ]));
    if (passwd(plan.account.name) || group(plan.account.name)
        || fs.readFileSync('/etc/subuid', 'utf8').split('\n').some(line => line.startsWith(`${plan.account.name}:`))
        || fs.readFileSync('/etc/subgid', 'utf8').split('\n').some(line => line.startsWith(`${plan.account.name}:`))
        || lstatMaybe(plan.host.tenantRoot) || lstatMaybe(plan.host.bridgeRoot)) {
      fail('destruction_failed');
    }
    guarded(mutationCapability, () => registry.retire(plan.runtimeKey));
    return receipt(plan, 'destroyed', true);
  }

  function verifyDestroyed(planValue) {
    const plan = selectedPlan(planValue, ['retired']);
    const allocation = registry.inspect(plan.runtimeKey);
    if (!allocation || allocation.status !== 'retired' || passwd(plan.account.name)
        || group(plan.account.name) || lstatMaybe(plan.host.tenantRoot)
        || fs.readFileSync('/etc/subuid', 'utf8').split('\n').some(line => line.startsWith(`${plan.account.name}:`))
        || fs.readFileSync('/etc/subgid', 'utf8').split('\n').some(line => line.startsWith(`${plan.account.name}:`))
        || lstatMaybe(plan.host.bridgeRoot) || lstatMaybe(path.join(unitRoot, plan.identity.unitName))
        || lstatMaybe(path.join(unitRoot, plan.identity.bridgeUnitName))) fail('destruction_failed');
    return receipt(plan, 'absent');
  }

  return Object.freeze({
    prepareAccount,
    materializeLayout,
    prepareImage,
    render,
    validate,
    install,
    start,
    stop,
    disable,
    inspect,
    inspectState,
    health,
    verifyPublication,
    rollbackState,
    restorePrior,
    commit,
    settleCommitted,
    rollback,
    rollbackStopped,
    startPrior,
    settleRollback,
    removeServices,
    inspectRemoved,
    settleRemoved,
    destroyAccount,
    verifyDestroyed,
  });
}

module.exports = { COMMANDS, createOciHostExecutor };
