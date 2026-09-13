'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROJECT_ROOT,
  resolveManagedInstallationRuntimePaths,
  managedInstallationRuntimeEnvironment,
} = require('../../../shared/paths/runtime-paths');
const { serverInstallationManifest } = require('../../../shared/contracts/src');
const { trustedCommandPath, resolveRootExecutable } = require('../../../shared/trusted-command-path');

const INSTALLATION_BASE_SERVICE_PLAN_VERSION = 2;
const INSTALLATION_SERVICE_PLAN_VERSION = 3;
const INSTALLATION_SERVICE_COUNT = 3;
const INSTALLATION_AGENT_SERVICE_COUNT = 4;
const INSTALLATION_SERVICE_COUNTS = Object.freeze([INSTALLATION_SERVICE_COUNT, INSTALLATION_AGENT_SERVICE_COUNT]);

function validServicePlanShape(version, count) {
  return version === INSTALLATION_BASE_SERVICE_PLAN_VERSION && count === INSTALLATION_SERVICE_COUNT
    || version === INSTALLATION_SERVICE_PLAN_VERSION && count === INSTALLATION_AGENT_SERVICE_COUNT;
}
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_UNIT_BYTES = 32 * 1024;
const MAX_JOURNAL_BYTES = 96 * 1024;
const MAX_SOURCE_EXECUTABLE_BYTES = 4 * 1024 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const RESERVED_SYSTEMD_VALUE = /[\0\r\n%"'\\]/;
const ENVIRONMENT_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ISSUED_SERVICE_PLANS = new WeakSet();

function fail(code = 'service_installation_failed') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required, code = 'runtime_boundary_violation') {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail(code);
  }
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || RESERVED_SYSTEMD_VALUE.test(value)) fail('runtime_boundary_violation');
  return value;
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function lstatMaybe(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail();
  }
}

function directoryIdentity(target, { exactPrivate = false, expectedDevice = null, trustedCode = false } = {}) {
  const selected = absolute(target);
  const info = lstatMaybe(selected);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || (info.uid !== process.geteuid() && !(trustedCode && info.uid === 0))
      || (exactPrivate ? (info.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE : (info.mode & 0o7022) !== 0)
      || expectedDevice !== null && info.dev !== expectedDevice) fail('runtime_boundary_violation');
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail('runtime_boundary_violation'); }
  if (canonical !== selected) fail('runtime_boundary_violation');
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function regularFile(target, expectedDevice, { executable = false } = {}) {
  const selected = absolute(target);
  const info = lstatMaybe(selected);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || !new Set([0, process.geteuid()]).has(info.uid) || (info.mode & 0o022) !== 0
      || executable && (info.mode & 0o111) === 0
      || expectedDevice !== null && info.dev !== expectedDevice) fail('runtime_boundary_violation');
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail('runtime_boundary_violation'); }
  if (canonical !== selected) fail('runtime_boundary_violation');
  return info;
}

function sourceIdentity(target) {
  const info = regularFile(target, null, { executable: true });
  if (info.size < 1 || info.size > MAX_SOURCE_EXECUTABLE_BYTES) fail('runtime_boundary_violation');
  let content;
  try { content = fs.readFileSync(target); } catch { fail('runtime_boundary_violation'); }
  return Object.freeze({ dev: info.dev, ino: info.ino, size: info.size, sha256: digest(content) });
}

function assertTrustedProjectPath(projectRoot, target) {
  const selected = absolute(target);
  if (!contains(projectRoot, selected) || selected === projectRoot) fail('runtime_boundary_violation');
  let current = path.dirname(selected);
  for (;;) {
    directoryIdentity(current, { trustedCode: true });
    if (current === projectRoot) break;
    const parent = path.dirname(current);
    if (parent === current || !contains(projectRoot, parent)) fail('runtime_boundary_violation');
    current = parent;
  }
}

function privateFile(target, expectedDevice, maximumBytes) {
  const info = regularFile(target, expectedDevice);
  if ((info.mode & 0o7777) !== PRIVATE_FILE_MODE || info.size < 1 || info.size > maximumBytes) fail();
  return info;
}

function candidateFile(target, expectedDevice) {
  return privateFile(target, expectedDevice, MAX_UNIT_BYTES);
}

function canonicalProjectRoot(value) {
  const selected = absolute(value);
  const identity = directoryIdentity(selected, { trustedCode: true });
  if (identity.dev === undefined) fail('runtime_boundary_violation');
  return selected;
}

function systemdEscape(value) {
  if (typeof value !== 'string' || RESERVED_SYSTEMD_VALUE.test(value)) fail('runtime_boundary_violation');
  let escaped = '';
  for (const character of value) {
    if (/^[A-Za-z0-9_./:@+-]$/.test(character)) escaped += character;
    else for (const byte of Buffer.from(character)) escaped += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return escaped;
}

function cleanExecStart(environmentLauncher, environment, executable) {
  const assignments = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!ENVIRONMENT_NAME_RE.test(key)) fail('runtime_boundary_violation');
      return `${key}=${value}`;
    });
  return [environmentLauncher, '--ignore-environment', ...assignments, executable]
    .map(systemdEscape).join(' ');
}

function digest(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function serviceJournalPath(unitRoot, runtimeKey) {
  return path.join(unitRoot, `.dispatch-service-${digest(runtimeKey).slice(0, 32)}.json`);
}

function receipt(selected, status, changed = false) {
  return Object.freeze({
    servicePlanVersion: selected.servicePlanVersion,
    status,
    serviceCount: selected.units.length,
    changed,
  });
}

function directMutation(operation) {
  return operation();
}

function isInstallationServicePlan(value) {
  return plain(value) && ISSUED_SERVICE_PLANS.has(value);
}

function syncDirectory(target) {
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(handle);
  } catch { fail(); }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
}

function writePrivateFile(target, content, expectedDevice, mutate, maximumBytes = MAX_UNIT_BYTES) {
  if (Buffer.byteLength(content, 'utf8') < 1 || Buffer.byteLength(content, 'utf8') > maximumBytes) fail();
  const existing = lstatMaybe(target);
  if (existing) {
    privateFile(target, expectedDevice, maximumBytes);
    let current;
    try { current = fs.readFileSync(target, 'utf8'); } catch { fail(); }
    if (current === content) return false;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    return mutate(() => {
      try {
        fs.writeFileSync(temporary, content, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
        const handle = fs.openSync(temporary, 'r');
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
        fs.renameSync(temporary, target);
        fs.chmodSync(target, PRIVATE_FILE_MODE);
        syncDirectory(path.dirname(target));
        privateFile(target, expectedDevice, maximumBytes);
        return true;
      } catch (error) {
        if (error?.code === 'installation_operation_in_progress') throw error;
        fail();
      }
    }) === true;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function authUnit({ runtimeKey, projectRoot, commandPath, environment, environmentLauncher }) {
  const workingDirectory = path.join(projectRoot, 'runtime', 'auth-broker');
  const executable = path.join(workingDirectory, 'bin', 'dispatch-auth-broker');
  const healthCommand = path.join(workingDirectory, 'bin', 'dispatch-auth-brokerctl');
  const name = `dispatch-runtime-${runtimeKey}-auth-broker.service`;
  const serviceEnvironment = Object.freeze({
    ...environment,
    PATH: commandPath,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_NO_WARNINGS: '1',
  });
  const lines = [
    '[Unit]',
    `Description=Dispatch managed Auth Broker (${runtimeKey})`,
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'UnsetEnvironment=DISPATCH_LOCAL_ROOT DISPATCH_ACCESS_CONTROL_DATABASE_ROOT NODE_OPTIONS LD_PRELOAD LD_LIBRARY_PATH',
    `WorkingDirectory=${systemdEscape(workingDirectory)}`,
    `ExecStart=${cleanExecStart(environmentLauncher, serviceEnvironment, executable)}`,
    'Restart=always',
    'RestartSec=2',
    'KillMode=control-group',
    'TimeoutStartSec=30',
    'TimeoutStopSec=30',
    'UMask=0077',
    'NoNewPrivileges=true',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'SystemCallArchitectures=native',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return {
    id: 'auth_broker',
    name,
    environmentLauncher,
    executable,
    expectedProcessArgument: executable,
    socketPath: serviceEnvironment.DISPATCH_AUTH_SOCKET,
    healthCommand,
    healthArguments: Object.freeze(['health']),
    workingDirectory,
    environment: serviceEnvironment,
    content: `${lines.join('\n')}\n`,
  };
}

function collectionUnit({ runtimeKey, projectRoot, commandPath, environment, authName, environmentLauncher }) {
  const workingDirectory = path.join(projectRoot, 'runtime', 'collection-manager');
  const executable = path.join(workingDirectory, 'bin', 'dispatch-collection-manager');
  const expectedProcessArgument = executable;
  const healthCommand = path.join(workingDirectory, 'bin', 'dispatch-collectionctl');
  const name = `dispatch-runtime-${runtimeKey}-collection-manager.service`;
  const serviceEnvironment = Object.freeze({
    ...environment,
    DISPATCH_MANAGED_RUNTIME: '1',
    PATH: commandPath,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_NO_WARNINGS: '1',
  });
  const lines = [
    '[Unit]',
    `Description=Dispatch managed Collection Manager (${runtimeKey})`,
    `After=local-fs.target ${authName}`,
    `Wants=${authName}`,
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'UnsetEnvironment=DISPATCH_LOCAL_ROOT DISPATCH_ACCESS_CONTROL_DATABASE_ROOT NODE_OPTIONS LD_PRELOAD LD_LIBRARY_PATH',
    `WorkingDirectory=${systemdEscape(workingDirectory)}`,
    `ExecStart=${cleanExecStart(environmentLauncher, serviceEnvironment, executable)}`,
    'Restart=always',
    'RestartSec=3',
    'KillMode=control-group',
    'TimeoutStartSec=30',
    'TimeoutStopSec=30',
    'UMask=0077',
    'NoNewPrivileges=true',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'RestrictNamespaces=true',
    'SystemCallArchitectures=native',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return {
    id: 'collection_manager',
    name,
    environmentLauncher,
    executable,
    expectedProcessArgument,
    socketPath: null,
    healthCommand,
    healthArguments: Object.freeze(['status']),
    workingDirectory,
    environment: serviceEnvironment,
    content: `${lines.join('\n')}\n`,
  };
}

function gatewayUnit({
  runtimeKey,
  projectRoot,
  commandPath,
  environment,
  authName,
  collectionName,
  environmentLauncher,
}) {
  const workingDirectory = path.join(projectRoot, 'runtime', 'gateway');
  const executable = path.join(workingDirectory, 'bin', 'dispatch-runtime-gateway');
  const healthCommand = path.join(workingDirectory, 'bin', 'dispatch-runtime-gatewayctl');
  const name = `dispatch-runtime-${runtimeKey}-gateway.service`;
  const serviceEnvironment = Object.freeze({
    ...environment,
    PATH: commandPath,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_NO_WARNINGS: '1',
  });
  const lines = [
    '[Unit]',
    `Description=Dispatch managed Runtime Gateway (${runtimeKey})`,
    `After=local-fs.target ${authName} ${collectionName}`,
    `Wants=${authName} ${collectionName}`,
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'UnsetEnvironment=DISPATCH_LOCAL_ROOT DISPATCH_ACCESS_CONTROL_DATABASE_ROOT NODE_OPTIONS LD_PRELOAD LD_LIBRARY_PATH',
    `WorkingDirectory=${systemdEscape(workingDirectory)}`,
    `ExecStart=${cleanExecStart(environmentLauncher, serviceEnvironment, executable)}`,
    'Restart=always',
    'RestartSec=2',
    'KillMode=control-group',
    'TimeoutStartSec=30',
    'TimeoutStopSec=30',
    'UMask=0077',
    'NoNewPrivileges=true',
    'RestrictAddressFamilies=AF_UNIX',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'RestrictNamespaces=true',
    'SystemCallArchitectures=native',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return {
    id: 'runtime_gateway',
    name,
    environmentLauncher,
    executable,
    expectedProcessArgument: executable,
    socketPath: serviceEnvironment.DISPATCH_RUNTIME_GATEWAY_SOCKET,
    healthCommand,
    healthArguments: Object.freeze(['health']),
    workingDirectory,
    environment: serviceEnvironment,
    content: `${lines.join('\n')}\n`,
  };
}

function runtimeAgentUnit({
  runtimeKey,
  projectRoot,
  commandPath,
  environment,
  gatewayName,
  gatewaySocket,
  hubSocket,
  tokenFile,
  statusSocket,
  environmentLauncher,
}) {
  const workingDirectory = path.join(projectRoot, 'runtime', 'agent');
  const executable = path.join(workingDirectory, 'bin', 'dispatch-runtime-agent');
  const healthCommand = path.join(workingDirectory, 'bin', 'dispatch-runtime-agentctl');
  const name = `dispatch-runtime-${runtimeKey}-agent.service`;
  const serviceEnvironment = Object.freeze({
    ...environment,
    DISPATCH_RUNTIME_KEY: runtimeKey,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: gatewaySocket,
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: hubSocket,
    DISPATCH_RUNTIME_AGENT_TOKEN_FILE: tokenFile,
    DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: statusSocket,
    PATH: commandPath,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_NO_WARNINGS: '1',
  });
  const lines = [
    '[Unit]',
    `Description=Dispatch managed Runtime Agent (${runtimeKey})`,
    `After=local-fs.target ${gatewayName}`,
    `Wants=${gatewayName}`,
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'UnsetEnvironment=DISPATCH_LOCAL_ROOT DISPATCH_ACCESS_CONTROL_DATABASE_ROOT NODE_OPTIONS LD_PRELOAD LD_LIBRARY_PATH',
    `WorkingDirectory=${systemdEscape(workingDirectory)}`,
    `ExecStart=${cleanExecStart(environmentLauncher, serviceEnvironment, executable)}`,
    'Restart=always',
    'RestartSec=2',
    'KillMode=control-group',
    'TimeoutStartSec=30',
    'TimeoutStopSec=30',
    'UMask=0077',
    'NoNewPrivileges=true',
    'RestrictAddressFamilies=AF_UNIX',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'RestrictNamespaces=true',
    'SystemCallArchitectures=native',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return {
    id: 'runtime_agent',
    name,
    environmentLauncher,
    executable,
    expectedProcessArgument: executable,
    socketPath: statusSocket,
    healthCommand,
    healthArguments: Object.freeze(['health']),
    workingDirectory,
    environment: serviceEnvironment,
    content: `${lines.join('\n')}\n`,
  };
}

function createInstallationServiceManager(options) {
  exact(options, ['unitRoot', 'projectRoot', 'commandPath', 'systemdAnalyze', 'runtimeAgentHubSocket'], ['unitRoot']);
  const unitRoot = absolute(options.unitRoot);
  const projectRoot = canonicalProjectRoot(options.projectRoot === undefined ? PROJECT_ROOT : options.projectRoot);
  if (contains(projectRoot, unitRoot) || contains(unitRoot, projectRoot)) fail('runtime_boundary_violation');
  const unitRootIdentity = directoryIdentity(unitRoot, { exactPrivate: true });
  let commandPath;
  try { commandPath = trustedCommandPath(options.commandPath === undefined ? process.env.PATH : options.commandPath); }
  catch { fail('runtime_boundary_violation'); }
  if (RESERVED_SYSTEMD_VALUE.test(commandPath)) fail('runtime_boundary_violation');
  const systemdAnalyze = resolveRootExecutable(options.systemdAnalyze, ['systemd-analyze']);
  if (!systemdAnalyze) fail('runtime_boundary_violation');
  const environmentLauncher = resolveRootExecutable(undefined, ['env']);
  if (!environmentLauncher) fail('runtime_boundary_violation');
  const runtimeAgentHubSocket = options.runtimeAgentHubSocket === undefined
    ? null : absolute(options.runtimeAgentHubSocket);
  if (runtimeAgentHubSocket !== null
      && path.basename(runtimeAgentHubSocket) !== 'runtime-agent-hub.sock') fail('runtime_boundary_violation');
  const issuedPlans = new WeakSet();

  function assertUnitRoot() {
    const current = directoryIdentity(unitRoot, { exactPrivate: true });
    if (!sameIdentity(unitRootIdentity, current)) fail('runtime_boundary_violation');
  }

  function plan(manifestValue, authorityValue, layout) {
    assertUnitRoot();
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    if (!plain(layout) || layout.runtimeKey !== manifest.runtime.key || layout.projectRoot !== projectRoot) {
      fail('runtime_identity_mismatch');
    }
    const managed = resolveManagedInstallationRuntimePaths(layout);
    if (contains(unitRoot, managed.installationRoot) || contains(managed.installationRoot, unitRoot)) {
      fail('runtime_boundary_violation');
    }
    const gatewaySocket = path.join(managed.runtimeRoot, 'runtime-gateway.sock');
    if ([managed.auth.socket, gatewaySocket]
      .some(socket => Buffer.byteLength(socket, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES)) {
      fail('runtime_boundary_violation');
    }
    const fullEnvironment = managedInstallationRuntimeEnvironment(layout);
    const authEnvironment = Object.freeze({
      DISPATCH_PROJECT_ROOT: fullEnvironment.DISPATCH_PROJECT_ROOT,
      DISPATCH_RUNTIME_ROOT: fullEnvironment.DISPATCH_RUNTIME_ROOT,
      DISPATCH_AUTH_DATABASE_ROOT: fullEnvironment.DISPATCH_AUTH_DATABASE_ROOT,
      DISPATCH_AUTH_SECRET_ROOT: fullEnvironment.DISPATCH_AUTH_SECRET_ROOT,
      DISPATCH_AUTH_STATE_ROOT: fullEnvironment.DISPATCH_AUTH_STATE_ROOT,
      DISPATCH_AUTH_SOCKET: fullEnvironment.DISPATCH_AUTH_SOCKET,
    });
    const candidateRoot = path.join(managed.configRoot, 'systemd');
    absolute(candidateRoot);
    const auth = authUnit({
      runtimeKey: manifest.runtime.key,
      projectRoot,
      commandPath,
      environment: authEnvironment,
      environmentLauncher,
    });
    const collection = collectionUnit({
      runtimeKey: manifest.runtime.key,
      projectRoot,
      commandPath,
      environment: fullEnvironment,
      authName: auth.name,
      environmentLauncher,
    });
    const gateway = gatewayUnit({
      runtimeKey: manifest.runtime.key,
      projectRoot,
      commandPath,
      environment: Object.freeze({
        ...fullEnvironment,
        DISPATCH_RUNTIME_KEY: manifest.runtime.key,
        DISPATCH_RUNTIME_GATEWAY_SOCKET: gatewaySocket,
      }),
      authName: auth.name,
      collectionName: collection.name,
      environmentLauncher,
    });
    const unitDefinitions = [auth, collection, gateway];
    if (runtimeAgentHubSocket !== null) {
      if (contains(projectRoot, runtimeAgentHubSocket)
          || contains(managed.installationRoot, runtimeAgentHubSocket)
          || contains(path.dirname(runtimeAgentHubSocket), managed.installationRoot)
          || [runtimeAgentHubSocket, managed.runtimeAgent.statusSocket]
            .some(socket => Buffer.byteLength(socket, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES)) {
        fail('runtime_boundary_violation');
      }
      unitDefinitions.push(runtimeAgentUnit({
        runtimeKey: manifest.runtime.key,
        projectRoot,
        commandPath,
        environment: fullEnvironment,
        gatewayName: gateway.name,
        gatewaySocket,
        hubSocket: runtimeAgentHubSocket,
        tokenFile: managed.runtimeAgent.registrationToken,
        statusSocket: managed.runtimeAgent.statusSocket,
        environmentLauncher,
      }));
    }
    const units = unitDefinitions.map(unit => {
      if (!/^[A-Za-z0-9_.@-]{1,220}\.service$/.test(unit.name)) fail('runtime_boundary_violation');
      assertTrustedProjectPath(projectRoot, unit.executable);
      assertTrustedProjectPath(projectRoot, unit.healthCommand);
      assertTrustedProjectPath(projectRoot, unit.workingDirectory);
      const executableIdentity = sourceIdentity(unit.executable);
      const healthCommandIdentity = sourceIdentity(unit.healthCommand);
      const workingDirectoryIdentity = directoryIdentity(unit.workingDirectory);
      return Object.freeze({
        ...unit,
        executableIdentity,
        healthCommandIdentity,
        workingDirectoryIdentity,
        candidate: path.join(candidateRoot, unit.name),
        installed: path.join(unitRoot, unit.name),
        sha256: digest(unit.content),
      });
    });
    const selectedPlan = Object.freeze({
      servicePlanVersion: runtimeAgentHubSocket === null
        ? INSTALLATION_BASE_SERVICE_PLAN_VERSION : INSTALLATION_SERVICE_PLAN_VERSION,
      runtimeKey: manifest.runtime.key,
      candidateRoot,
      journal: serviceJournalPath(unitRoot, manifest.runtime.key),
      unitRoot,
      units: Object.freeze(units),
    });
    issuedPlans.add(selectedPlan);
    ISSUED_SERVICE_PLANS.add(selectedPlan);
    return selectedPlan;
  }

  function ensureCandidateRoot(selected, mutate) {
    const configRoot = path.dirname(selected.candidateRoot);
    const configIdentity = directoryIdentity(configRoot, { exactPrivate: true });
    if (!lstatMaybe(selected.candidateRoot)) {
      mutate(() => {
        if (!lstatMaybe(selected.candidateRoot)) {
          fs.mkdirSync(selected.candidateRoot, { mode: PRIVATE_DIRECTORY_MODE });
          syncDirectory(configRoot);
        }
      });
    }
    directoryIdentity(selected.candidateRoot, { exactPrivate: true, expectedDevice: configIdentity.dev });
    const after = directoryIdentity(configRoot, { exactPrivate: true });
    if (!sameIdentity(configIdentity, after)) fail();
  }

  function validatePlan(selected) {
    if (!plain(selected) || !issuedPlans.has(selected)
        || !validServicePlanShape(selected.servicePlanVersion, selected.units?.length)
        || selected.unitRoot !== unitRoot || !Array.isArray(selected.units)
        || !INSTALLATION_SERVICE_COUNTS.includes(selected.units.length)
        || selected.units.length !== (runtimeAgentHubSocket === null
          ? INSTALLATION_SERVICE_COUNT : INSTALLATION_AGENT_SERVICE_COUNT)
        || selected.journal !== serviceJournalPath(unitRoot, selected.runtimeKey)) {
      fail('runtime_boundary_violation');
    }
    assertUnitRoot();
    for (const unit of selected.units) {
      const currentLauncher = resolveRootExecutable(unit.environmentLauncher, []);
      if (currentLauncher !== environmentLauncher) fail('runtime_boundary_violation');
      assertTrustedProjectPath(projectRoot, unit.executable);
      assertTrustedProjectPath(projectRoot, unit.healthCommand);
      assertTrustedProjectPath(projectRoot, unit.workingDirectory);
      const executable = sourceIdentity(unit.executable);
      const health = sourceIdentity(unit.healthCommand);
      const working = directoryIdentity(unit.workingDirectory);
      if (!sameIdentity(executable, unit.executableIdentity)
          || executable.size !== unit.executableIdentity.size
          || executable.sha256 !== unit.executableIdentity.sha256
          || !sameIdentity(health, unit.healthCommandIdentity)
          || health.size !== unit.healthCommandIdentity.size
          || health.sha256 !== unit.healthCommandIdentity.sha256
          || !sameIdentity(working, unit.workingDirectoryIdentity)) {
        fail('runtime_boundary_violation');
      }
    }
    return selected;
  }

  function render(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    ensureCandidateRoot(selected, mutationCapability);
    let entries;
    try { entries = fs.readdirSync(selected.candidateRoot); } catch { fail(); }
    const expected = new Set(selected.units.map(unit => unit.name));
    if (entries.some(entry => !expected.has(entry))) fail();
    const identity = directoryIdentity(selected.candidateRoot, { exactPrivate: true });
    let changed = false;
    for (const unit of selected.units) {
      assertUnitRoot();
      changed = writePrivateFile(unit.candidate, unit.content, identity.dev, mutationCapability) || changed;
    }
    inspect(selected);
    return receipt(selected, 'rendered', changed);
  }

  function inspect(selectedValue) {
    const selected = validatePlan(selectedValue);
    const identity = directoryIdentity(selected.candidateRoot, { exactPrivate: true });
    const expected = new Set(selected.units.map(unit => unit.name));
    let entries;
    try { entries = fs.readdirSync(selected.candidateRoot); } catch { fail(); }
    if (entries.length !== expected.size || entries.some(entry => !expected.has(entry))) fail();
    for (const unit of selected.units) {
      candidateFile(unit.candidate, identity.dev);
      let content;
      try { content = fs.readFileSync(unit.candidate, 'utf8'); } catch { fail(); }
      if (content !== unit.content || digest(content) !== unit.sha256) fail();
    }
    assertUnitRoot();
    return receipt(selected, 'verified');
  }

  function validate(selectedValue) {
    const selected = validatePlan(selectedValue);
    inspect(selected);
    const result = spawnSync(systemdAnalyze, ['verify', ...selected.units.map(unit => unit.candidate)], {
      cwd: projectRoot,
      env: { PATH: commandPath, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) fail();
    inspect(selected);
    return receipt(selected, 'validated');
  }

  function readPrivateContent(target, expectedDevice, maximumBytes) {
    privateFile(target, expectedDevice, maximumBytes);
    let raw;
    try { raw = fs.readFileSync(target); } catch { fail(); }
    const content = raw.toString('utf8');
    if (!raw.equals(Buffer.from(content, 'utf8')) || content.includes('\0')) fail();
    return content;
  }

  function checkedSupervisorState(selected, value) {
    if (!Array.isArray(value) || value.length !== selected.units.length) fail('runtime_boundary_violation');
    return Object.freeze(selected.units.map((unit, index) => {
      const state = value[index];
      exact(
        state,
        ['id', 'name', 'enabled', 'active', 'enableMode'],
        ['id', 'name', 'enabled', 'active', 'enableMode'],
      );
      if (state.id !== unit.id || state.name !== unit.name
          || typeof state.enabled !== 'boolean' || typeof state.active !== 'boolean'
          || !['none', 'runtime', 'persistent'].includes(state.enableMode)
          || state.enabled !== (state.enableMode !== 'none')) {
        fail('runtime_boundary_violation');
      }
      return Object.freeze({ ...state });
    }));
  }

  function checkedJournal(selected, value) {
    exact(
      value,
      ['version', 'servicePlanVersion', 'runtimeKey', 'phase', 'units'],
      ['version', 'servicePlanVersion', 'runtimeKey', 'phase', 'units'],
    );
    if (value.version !== 1 || value.servicePlanVersion !== selected.servicePlanVersion
        || value.runtimeKey !== selected.runtimeKey
        || !['installing', 'installed', 'verified', 'restored'].includes(value.phase)
        || !Array.isArray(value.units) || value.units.length !== selected.units.length) {
      fail('runtime_boundary_violation');
    }
    const units = selected.units.map((unit, index) => {
      const entry = value.units[index];
      exact(
        entry,
        ['id', 'name', 'candidateSha256', 'previous'],
        ['id', 'name', 'candidateSha256', 'previous'],
      );
      exact(
        entry.previous,
        ['present', 'content', 'sha256', 'enabled', 'active', 'enableMode'],
        ['present', 'content', 'sha256', 'enabled', 'active', 'enableMode'],
      );
      if (entry.id !== unit.id || entry.name !== unit.name || entry.candidateSha256 !== unit.sha256
          || typeof entry.previous.present !== 'boolean' || typeof entry.previous.enabled !== 'boolean'
          || typeof entry.previous.active !== 'boolean'
          || !['none', 'runtime', 'persistent'].includes(entry.previous.enableMode)
          || entry.previous.enabled !== (entry.previous.enableMode !== 'none')) {
        fail('runtime_boundary_violation');
      }
      if (entry.previous.present) {
        if (typeof entry.previous.content !== 'string' || typeof entry.previous.sha256 !== 'string'
            || digest(entry.previous.content) !== entry.previous.sha256
            || Buffer.byteLength(entry.previous.content, 'utf8') < 1
            || Buffer.byteLength(entry.previous.content, 'utf8') > MAX_UNIT_BYTES) fail('runtime_boundary_violation');
      } else if (entry.previous.content !== null || entry.previous.sha256 !== null
          || entry.previous.enabled || entry.previous.active || entry.previous.enableMode !== 'none') {
        fail('runtime_boundary_violation');
      }
      return Object.freeze({
        id: entry.id,
        name: entry.name,
        candidateSha256: entry.candidateSha256,
        previous: Object.freeze({ ...entry.previous }),
      });
    });
    return Object.freeze({ ...value, units: Object.freeze(units) });
  }

  function loadJournal(selectedValue, { required = false } = {}) {
    const selected = validatePlan(selectedValue);
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    if (!lstatMaybe(selected.journal)) {
      if (required) fail();
      return null;
    }
    const raw = readPrivateContent(selected.journal, identity.dev, MAX_JOURNAL_BYTES);
    if (!raw.endsWith('\n') || raw.includes('\r')) fail();
    let parsed;
    try { parsed = JSON.parse(raw.slice(0, -1)); } catch { fail(); }
    return checkedJournal(selected, parsed);
  }

  function writeJournal(selected, journal, mutationCapability) {
    const checked = checkedJournal(selected, journal);
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    writePrivateFile(
      selected.journal,
      `${JSON.stringify(checked)}\n`,
      identity.dev,
      mutationCapability,
      MAX_JOURNAL_BYTES,
    );
    return loadJournal(selected, { required: true });
  }

  function captureJournal(selected, supervisorState, mutationCapability) {
    const existing = loadJournal(selected);
    if (existing) return existing;
    const states = checkedSupervisorState(selected, supervisorState);
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    const units = selected.units.map((unit, index) => {
      const present = Boolean(lstatMaybe(unit.installed));
      let content = null;
      let sha256 = null;
      if (present) {
        content = readPrivateContent(unit.installed, identity.dev, MAX_UNIT_BYTES);
        sha256 = digest(content);
      } else if (states[index].enabled || states[index].active) {
        fail('runtime_boundary_violation');
      }
      return {
        id: unit.id,
        name: unit.name,
        candidateSha256: unit.sha256,
        previous: {
          present,
          content,
          sha256,
          enabled: states[index].enabled,
          active: states[index].active,
          enableMode: states[index].enableMode,
        },
      };
    });
    return writeJournal(selected, {
      version: 1,
      servicePlanVersion: selected.servicePlanVersion,
      runtimeKey: selected.runtimeKey,
      phase: 'installing',
      units,
    }, mutationCapability);
  }

  function inspectInstalled(selectedValue) {
    const selected = validatePlan(selectedValue);
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    for (const unit of selected.units) {
      const content = readPrivateContent(unit.installed, identity.dev, MAX_UNIT_BYTES);
      if (content !== unit.content || digest(content) !== unit.sha256) fail();
    }
    return receipt(selected, 'installed');
  }

  function install(selectedValue, supervisorState, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    inspect(selected);
    const journal = captureJournal(selected, supervisorState, mutationCapability);
    if (['verified', 'restored'].includes(journal.phase)) fail();
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    let changed = false;
    for (const unit of selected.units) {
      changed = writePrivateFile(unit.installed, unit.content, identity.dev, mutationCapability) || changed;
    }
    writeJournal(selected, { ...journal, phase: 'installed' }, mutationCapability);
    inspectInstalled(selected);
    return receipt(selected, 'installed', changed);
  }

  function rollbackState(selectedValue) {
    const selected = validatePlan(selectedValue);
    const journal = loadJournal(selected);
    if (!journal) return null;
    return Object.freeze(journal.units.map(entry => Object.freeze({
      id: entry.id,
      name: entry.name,
      enabled: entry.previous.enabled,
      active: entry.previous.active,
      enableMode: entry.previous.enableMode,
    })));
  }

  function restoreFiles(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    const journal = loadJournal(selected, { required: true });
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    let changed = false;
    for (let index = selected.units.length - 1; index >= 0; index -= 1) {
      const unit = selected.units[index];
      const previous = journal.units[index].previous;
      const exists = Boolean(lstatMaybe(unit.installed));
      let current = null;
      if (exists) current = readPrivateContent(unit.installed, identity.dev, MAX_UNIT_BYTES);
      if (previous.present) {
        if (current === previous.content) continue;
        if (current !== unit.content) fail();
        changed = writePrivateFile(
          unit.installed,
          previous.content,
          identity.dev,
          mutationCapability,
        ) || changed;
      } else {
        if (!exists) continue;
        if (current !== unit.content) fail();
        mutationCapability(() => {
          const verified = readPrivateContent(unit.installed, identity.dev, MAX_UNIT_BYTES);
          if (verified !== unit.content) fail();
          fs.unlinkSync(unit.installed);
          syncDirectory(selected.unitRoot);
        });
        changed = true;
      }
    }
    writeJournal(selected, { ...journal, phase: 'restored' }, mutationCapability);
    return receipt(selected, 'restored', changed);
  }

  function verifyRestored(selected, journal) {
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    for (let index = 0; index < selected.units.length; index += 1) {
      const unit = selected.units[index];
      const previous = journal.units[index].previous;
      if (!previous.present) {
        if (lstatMaybe(unit.installed)) fail();
        continue;
      }
      const current = readPrivateContent(unit.installed, identity.dev, MAX_UNIT_BYTES);
      if (current !== previous.content || digest(current) !== previous.sha256) fail();
    }
  }

  function removeJournal(selected, mutationCapability) {
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    mutationCapability(() => {
      privateFile(selected.journal, identity.dev, MAX_JOURNAL_BYTES);
      fs.unlinkSync(selected.journal);
      syncDirectory(unitRoot);
    });
    if (lstatMaybe(selected.journal)) fail();
  }

  function finishRollback(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    const journal = loadJournal(selected, { required: true });
    if (journal.phase !== 'restored') fail();
    verifyRestored(selected, journal);
    removeJournal(selected, mutationCapability);
    return receipt(selected, 'rolled_back', true);
  }

  function markVerified(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    inspectInstalled(selected);
    const journal = loadJournal(selected, { required: true });
    if (journal.phase === 'verified') return receipt(selected, 'verified');
    if (journal.phase !== 'installed') fail();
    writeJournal(selected, { ...journal, phase: 'verified' }, mutationCapability);
    return receipt(selected, 'verified', true);
  }

  function commit(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    const journal = loadJournal(selected, { required: true });
    if (journal.phase !== 'verified') fail();
    inspectInstalled(selected);
    removeJournal(selected, mutationCapability);
    return receipt(selected, 'committed', true);
  }

  function finalizeSettled(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    const journal = loadJournal(selected);
    if (!journal) return receipt(selected, 'settled');
    if (journal.phase === 'verified') return commit(selected, mutationCapability);
    if (journal.phase === 'restored') return finishRollback(selected, mutationCapability);
    fail();
  }

  function removeCandidate(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    const journal = loadJournal(selected);
    if (journal && journal.phase !== 'restored') fail();
    if (!lstatMaybe(selected.candidateRoot)) return receipt(selected, 'candidate_removed');
    const candidateIdentity = directoryIdentity(selected.candidateRoot, { exactPrivate: true });
    const expected = new Set(selected.units.map(unit => unit.name));
    let entries;
    try { entries = fs.readdirSync(selected.candidateRoot); } catch { fail(); }
    if (entries.some(entry => !expected.has(entry))) fail();
    for (const unit of [...selected.units].reverse()) {
      if (!lstatMaybe(unit.candidate)) continue;
      mutationCapability(() => {
        const content = readPrivateContent(unit.candidate, candidateIdentity.dev, MAX_UNIT_BYTES);
        if (content !== unit.content) fail();
        fs.unlinkSync(unit.candidate);
        syncDirectory(selected.candidateRoot);
      });
    }
    const configRoot = path.dirname(selected.candidateRoot);
    mutationCapability(() => {
      const current = directoryIdentity(selected.candidateRoot, {
        exactPrivate: true,
        expectedDevice: candidateIdentity.dev,
      });
      if (!sameIdentity(candidateIdentity, current) || fs.readdirSync(selected.candidateRoot).length !== 0) fail();
      fs.rmdirSync(selected.candidateRoot);
      syncDirectory(configRoot);
    });
    if (lstatMaybe(selected.candidateRoot)) fail();
    return receipt(selected, 'candidate_removed', true);
  }

  function removeInstalled(selectedValue, mutationCapability = directMutation) {
    const selected = validatePlan(selectedValue);
    if (typeof mutationCapability !== 'function' || loadJournal(selected)) fail('runtime_boundary_violation');
    const identity = directoryIdentity(unitRoot, { exactPrivate: true });
    let changed = false;
    for (const unit of [...selected.units].reverse()) {
      if (!lstatMaybe(unit.installed)) continue;
      mutationCapability(() => {
        const content = readPrivateContent(unit.installed, identity.dev, MAX_UNIT_BYTES);
        if (content !== unit.content || digest(content) !== unit.sha256) fail();
        fs.unlinkSync(unit.installed);
        syncDirectory(unitRoot);
      });
      changed = true;
    }
    for (const unit of selected.units) if (lstatMaybe(unit.installed)) fail();
    return receipt(selected, 'removed', changed);
  }

  function inspectAbsent(selectedValue) {
    const selected = validatePlan(selectedValue);
    if (loadJournal(selected) || selected.units.some(unit => lstatMaybe(unit.installed))) fail();
    return receipt(selected, 'absent');
  }

  return Object.freeze({
    plan,
    render,
    inspect,
    validate,
    install,
    inspectInstalled,
    rollbackState,
    restoreFiles,
    finishRollback,
    markVerified,
    commit,
    finalizeSettled,
    removeCandidate,
    removeInstalled,
    inspectAbsent,
  });
}

module.exports = {
  INSTALLATION_BASE_SERVICE_PLAN_VERSION,
  INSTALLATION_SERVICE_PLAN_VERSION,
  INSTALLATION_SERVICE_COUNT,
  INSTALLATION_AGENT_SERVICE_COUNT,
  INSTALLATION_SERVICE_COUNTS,
  validServicePlanShape,
  MAX_UNIT_BYTES,
  isInstallationServicePlan,
  createInstallationServiceManager,
};
