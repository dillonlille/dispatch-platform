'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveRootExecutable, trustedCommandPath } = require('../../../shared/trusted-command-path');
const {
  isInstallationServicePlan,
  INSTALLATION_SERVICE_COUNTS,
  validServicePlanShape,
} = require('./services');

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 50;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

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

function positiveInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('runtime_boundary_violation');
  return value;
}

function absoluteExecutable(value, names) {
  const resolved = resolveRootExecutable(value, names);
  if (!resolved) fail('runtime_boundary_violation');
  return resolved;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseProperties(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) fail();
  const selected = {};
  for (const line of output.trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) fail();
    const key = line.slice(0, separator);
    if (Object.hasOwn(selected, key)) fail();
    selected[key] = line.slice(separator + 1);
  }
  return selected;
}

function parseJsonLine(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_COMMAND_OUTPUT_BYTES
      || !output.endsWith('\n') || output.includes('\r') || output.slice(0, -1).includes('\n')) fail();
  try {
    const value = JSON.parse(output.slice(0, -1));
    if (!plain(value)) fail();
    return value;
  } catch (error) {
    if (error?.code) throw error;
    fail();
  }
}

function receipt(plan, status, changed = false) {
  return Object.freeze({
    servicePlanVersion: plan.servicePlanVersion,
    status,
    serviceCount: plan.units.length,
    changed,
  });
}

function createSystemdUserSupervisor(options = {}) {
  exact(
    options,
    ['systemctl', 'commandPath', 'runtimeOnly', 'waitTimeoutMs', 'pollMs', 'clock'],
    [],
  );
  const systemctl = absoluteExecutable(options.systemctl, ['systemctl']);
  if (typeof process.geteuid !== 'function') fail('runtime_boundary_violation');
  const runtimeDirectory = `/run/user/${process.geteuid()}`;
  let runtimeInfo;
  try { runtimeInfo = fs.lstatSync(runtimeDirectory); } catch { fail('runtime_boundary_violation'); }
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || runtimeInfo.uid !== process.geteuid()
      || (runtimeInfo.mode & 0o7777) !== 0o700 || fs.realpathSync(runtimeDirectory) !== runtimeDirectory) {
    fail('runtime_boundary_violation');
  }
  const busPath = path.join(runtimeDirectory, 'bus');
  let commandPath;
  try { commandPath = trustedCommandPath(options.commandPath === undefined ? process.env.PATH : options.commandPath); }
  catch { fail('runtime_boundary_violation'); }
  const runtimeOnly = options.runtimeOnly === undefined ? true : options.runtimeOnly;
  if (typeof runtimeOnly !== 'boolean') fail('runtime_boundary_violation');
  const waitTimeoutMs = positiveInteger(
    options.waitTimeoutMs === undefined ? DEFAULT_WAIT_TIMEOUT_MS : options.waitTimeoutMs,
    100,
    120_000,
  );
  const pollMs = positiveInteger(options.pollMs === undefined ? DEFAULT_POLL_MS : options.pollMs, 10, 1_000);
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof clock !== 'function') fail('runtime_boundary_violation');

  function execute(args, { accepted = [0], timeout = 30_000 } = {}) {
    if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string'
        || /[\0\r\n]/.test(argument))) fail('runtime_boundary_violation');
    const result = spawnSync(systemctl, ['--user', '--no-pager', ...args], {
      env: {
        PATH: commandPath,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        XDG_RUNTIME_DIR: runtimeDirectory,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`,
      },
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    if (result.error || !accepted.includes(result.status)
        || Buffer.byteLength(result.stdout || '', 'utf8') > MAX_COMMAND_OUTPUT_BYTES
        || Buffer.byteLength(result.stderr || '', 'utf8') > MAX_COMMAND_OUTPUT_BYTES) fail();
    return result;
  }

  function units(plan) {
    if (!isInstallationServicePlan(plan)
        || !validServicePlanShape(plan.servicePlanVersion, plan.units?.length) || !Array.isArray(plan.units)
        || !INSTALLATION_SERVICE_COUNTS.includes(plan.units.length)) fail('runtime_boundary_violation');
    for (const unit of plan.units) {
      if (!plain(unit) || !['auth_broker', 'collection_manager', 'runtime_gateway', 'runtime_agent'].includes(unit.id)
          || typeof unit.name !== 'string' || !/^[A-Za-z0-9_.@-]{1,220}\.service$/.test(unit.name)
          || typeof unit.installed !== 'string' || path.basename(unit.installed) !== unit.name
          || !path.isAbsolute(unit.installed) || typeof unit.expectedProcessArgument !== 'string'
          || !path.isAbsolute(unit.expectedProcessArgument) || typeof unit.healthCommand !== 'string'
          || !path.isAbsolute(unit.healthCommand) || !Array.isArray(unit.healthArguments)
          || unit.socketPath !== null && (typeof unit.socketPath !== 'string' || !path.isAbsolute(unit.socketPath))
          || !plain(unit.environment)) fail('runtime_boundary_violation');
    }
    if (new Set(plan.units.map(unit => unit.id)).size !== plan.units.length
        || new Set(plan.units.map(unit => unit.name)).size !== plan.units.length) {
      fail('runtime_boundary_violation');
    }
    return plan.units;
  }

  function state(unit) {
    const result = execute([
      'show',
      unit.name,
      '--property=Id,LoadState,ActiveState,SubState,MainPID,NRestarts,FragmentPath,ExecStart,Restart,KillMode,UMask,UnitFileState,ControlGroup',
    ], { accepted: [0, 1] });
    if (result.status !== 0) return Object.freeze({ loaded: false, active: false, enabled: false });
    const properties = parseProperties(result.stdout);
    if (properties.Id !== unit.name) fail();
    return Object.freeze({
      loaded: properties.LoadState === 'loaded',
      active: properties.ActiveState === 'active' && properties.SubState === 'running',
      activeState: properties.ActiveState,
      enabled: ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'].includes(properties.UnitFileState),
      pid: Number(properties.MainPID),
      restarts: Number(properties.NRestarts),
      fragment: properties.FragmentPath,
      execStart: properties.ExecStart,
      restart: properties.Restart,
      killMode: properties.KillMode,
      umask: properties.UMask,
      unitFileState: properties.UnitFileState,
      controlGroup: properties.ControlGroup,
    });
  }

  function snapshot(plan) {
    return Object.freeze(units(plan).map(unit => {
      const current = state(unit);
      if (current.loaded && current.fragment !== unit.installed) fail('runtime_boundary_violation');
      const enableMode = ['enabled-runtime', 'linked-runtime'].includes(current.unitFileState)
        ? 'runtime'
        : (['enabled', 'linked'].includes(current.unitFileState) ? 'persistent' : 'none');
      return Object.freeze({
        id: unit.id,
        name: unit.name,
        enabled: current.enabled === true,
        active: current.loaded === true && !['inactive', 'failed'].includes(current.activeState),
        enableMode,
      });
    }));
  }

  function mutateCall(mutationCapability, callback) {
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    return mutationCapability(callback);
  }

  function reload(plan, mutationCapability) {
    units(plan);
    mutateCall(mutationCapability, () => execute(['daemon-reload']));
    return receipt(plan, 'reloaded', true);
  }

  function enable(plan, mutationCapability) {
    const selected = units(plan);
    for (const unit of selected) {
      const current = state(unit);
      if (!current.loaded || current.fragment !== unit.installed) fail('runtime_boundary_violation');
      const args = ['enable', '--no-reload'];
      if (runtimeOnly) args.push('--runtime');
      args.push(unit.name);
      mutateCall(mutationCapability, () => execute(args));
    }
    reload(plan, mutationCapability);
    return receipt(plan, 'enabled', true);
  }

  function disable(plan, mutationCapability) {
    const selected = [...units(plan)].reverse();
    for (const unit of selected) {
      const current = state(unit);
      if (current.loaded && current.fragment !== unit.installed) fail('runtime_boundary_violation');
      if (!current.loaded) continue;
      const args = ['disable', '--no-reload'];
      if (runtimeOnly) args.push('--runtime');
      args.push(unit.name);
      mutateCall(mutationCapability, () => execute(args, { accepted: [0, 1] }));
    }
    reload(plan, mutationCapability);
    return receipt(plan, 'disabled', true);
  }

  function waitFor(unit, predicate) {
    const deadline = clock() + waitTimeoutMs;
    for (;;) {
      const current = state(unit);
      if (predicate(current)) return current;
      if (clock() >= deadline) fail('runtime_health_failed');
      sleep(pollMs);
    }
  }

  function start(plan, mutationCapability) {
    const selected = units(plan);
    for (const unit of selected) {
      const current = state(unit);
      if (!current.loaded || current.fragment !== unit.installed) fail('runtime_boundary_violation');
      mutateCall(mutationCapability, () => execute(['start', '--no-block', unit.name]));
      waitFor(unit, current => {
        if (!current.active || !Number.isSafeInteger(current.pid) || current.pid < 1) return false;
        try { return processArguments(current.pid).includes(unit.expectedProcessArgument); } catch { return false; }
      });
    }
    return receipt(plan, 'started', true);
  }

  function stop(plan, mutationCapability) {
    const selected = [...units(plan)].reverse();
    for (const unit of selected) {
      const current = state(unit);
      if (current.loaded && current.fragment !== unit.installed) fail('runtime_boundary_violation');
      if (!current.loaded) continue;
      mutateCall(mutationCapability, () => execute(['stop', '--no-block', unit.name], { accepted: [0, 1] }));
      waitFor(unit, current => ['inactive', 'failed'].includes(current.activeState));
    }
    return receipt(plan, 'stopped', true);
  }

  function resetFailed(plan, mutationCapability) {
    for (const unit of [...units(plan)].reverse()) {
      const current = state(unit);
      if (current.loaded && current.fragment !== unit.installed) fail('runtime_boundary_violation');
      if (!current.loaded) continue;
      mutateCall(mutationCapability, () => execute(
        ['reset-failed', unit.name],
        { accepted: [0, 1] },
      ));
    }
    return receipt(plan, 'failure_state_reset', true);
  }

  function restoreState(plan, snapshotValue, mutationCapability) {
    const selected = units(plan);
    if (!Array.isArray(snapshotValue) || snapshotValue.length !== selected.length) {
      fail('runtime_boundary_violation');
    }
    const snapshot = selected.map((unit, index) => {
      const value = snapshotValue[index];
      exact(
        value,
        ['id', 'name', 'enabled', 'active', 'enableMode'],
        ['id', 'name', 'enabled', 'active', 'enableMode'],
      );
      if (value.id !== unit.id || value.name !== unit.name
          || typeof value.enabled !== 'boolean' || typeof value.active !== 'boolean'
          || !['none', 'runtime', 'persistent'].includes(value.enableMode)
          || value.enabled !== (value.enableMode !== 'none')) {
        fail('runtime_boundary_violation');
      }
      return value;
    });
    for (let index = 0; index < selected.length; index += 1) {
      if (!snapshot[index].enabled) continue;
      const current = state(selected[index]);
      if (!current.loaded || current.fragment !== selected[index].installed) fail('runtime_boundary_violation');
      const args = ['enable', '--no-reload'];
      if (snapshot[index].enableMode === 'runtime') args.push('--runtime');
      args.push(selected[index].name);
      mutateCall(mutationCapability, () => execute(args));
    }
    reload(plan, mutationCapability);
    for (let index = 0; index < selected.length; index += 1) {
      if (!snapshot[index].active) continue;
      const current = state(selected[index]);
      if (!current.loaded || current.fragment !== selected[index].installed) fail('runtime_boundary_violation');
      mutateCall(mutationCapability, () => execute(['start', '--no-block', selected[index].name]));
      waitFor(selected[index], current => current.active === true);
    }
    return receipt(plan, 'state_restored', true);
  }

  function processEnvironment(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) fail('runtime_health_failed');
    let raw;
    try { raw = fs.readFileSync(`/proc/${pid}/environ`); } catch { fail('runtime_health_failed'); }
    if (raw.length > MAX_COMMAND_OUTPUT_BYTES) fail('runtime_health_failed');
    const result = {};
    for (const entry of raw.toString('utf8').split('\0').filter(Boolean)) {
      const separator = entry.indexOf('=');
      if (separator < 1) fail('runtime_health_failed');
      result[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return result;
  }

  function processArguments(pid) {
    let raw;
    try { raw = fs.readFileSync(`/proc/${pid}/cmdline`); } catch { fail('runtime_health_failed'); }
    if (raw.length < 2 || raw.length > MAX_COMMAND_OUTPUT_BYTES) fail('runtime_health_failed');
    return raw.toString('utf8').split('\0').filter(Boolean);
  }

  function verifyUnixSocketOwner(socketPath, pid) {
    let info;
    try { info = fs.lstatSync(socketPath); } catch { fail('runtime_health_failed'); }
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.geteuid()
        || (info.mode & 0o7777) !== 0o600 || fs.realpathSync(socketPath) !== socketPath) {
      fail('runtime_health_failed');
    }
    let table;
    try { table = fs.readFileSync('/proc/net/unix', 'utf8'); } catch { fail('runtime_health_failed'); }
    let inode = null;
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 8 && fields.slice(7).join(' ') === socketPath && /^\d+$/.test(fields[6])) {
        inode = fields[6];
        break;
      }
    }
    if (!inode) fail('runtime_health_failed');
    let descriptors;
    try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { fail('runtime_health_failed'); }
    const expected = `socket:[${inode}]`;
    const owned = descriptors.some(descriptor => {
      try { return fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`) === expected; } catch { return false; }
    });
    if (!owned) fail('runtime_health_failed');
  }

  function inspect(plan) {
    for (const unit of units(plan)) {
      const current = state(unit);
      if (!current.loaded || !current.active || !current.enabled
          || current.fragment !== unit.installed || current.restart !== 'always'
          || current.killMode !== 'control-group' || current.umask !== '0077'
          || !Number.isSafeInteger(current.pid) || current.pid < 1
          || !Number.isSafeInteger(current.restarts) || current.restarts < 0
          || typeof current.execStart !== 'string'
          || !current.execStart.includes(`path=${unit.environmentLauncher}`)
          || !current.execStart.includes(unit.executable)) {
        fail('runtime_health_failed');
      }
      let processInfo;
      try { processInfo = fs.statSync(`/proc/${current.pid}`); } catch { fail('runtime_health_failed'); }
      if (processInfo.uid !== process.geteuid()) fail('runtime_health_failed');
      if (typeof current.controlGroup !== 'string' || !current.controlGroup.startsWith('/')) {
        fail('runtime_health_failed');
      }
      let cgroups;
      try { cgroups = fs.readFileSync(`/proc/${current.pid}/cgroup`, 'utf8'); } catch { fail('runtime_health_failed'); }
      if (!cgroups.split('\n').some(line => {
        const separator = line.indexOf('::');
        return separator >= 0 && line.slice(separator + 2) === current.controlGroup;
      })) {
        fail('runtime_health_failed');
      }
      const argumentsList = processArguments(current.pid);
      if (!argumentsList.includes(unit.expectedProcessArgument)) fail('runtime_health_failed');
      const environment = processEnvironment(current.pid);
      for (const [key, value] of Object.entries(unit.environment)) {
        if (environment[key] !== value) fail('runtime_health_failed');
      }
      if (JSON.stringify(Object.keys(environment).sort())
          !== JSON.stringify(Object.keys(unit.environment).sort())) fail('runtime_health_failed');
      if (Object.hasOwn(environment, 'DISPATCH_LOCAL_ROOT')
          || Object.keys(environment).some(key => key.startsWith('DISPATCH_ACCESS_CONTROL'))
          || ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].some(key => Object.hasOwn(environment, key))) {
        fail('runtime_health_failed');
      }
    }
    return receipt(plan, 'active');
  }

  function health(plan) {
    inspect(plan);
    for (const unit of units(plan)) {
      const deadline = clock() + waitTimeoutMs;
      for (;;) {
        const result = spawnSync(unit.healthCommand, unit.healthArguments, {
          cwd: unit.workingDirectory,
          env: unit.environment,
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        });
        let response = null;
        try {
          if (!result.error && result.signal === null) response = parseJsonLine(result.stdout);
        } catch {}
        const statusReady = response?.ok === true && ['ready', 'verified'].includes(response.status);
        const managerReady = unit.id !== 'collection_manager'
          || (plain(response?.data) && plain(response.data.manager) && response.data.manager.running === true);
        if (result.status === 0 && statusReady && managerReady) break;
        const startupState = [
          'broker_unavailable',
          'collection_manager_not_initialized',
          'runtime_gateway_unavailable',
          'runtime_agent_unavailable',
        ].includes(response?.status)
          || (unit.id === 'collection_manager' && response?.ok === true && managerReady === false);
        if (!startupState || clock() >= deadline) fail('runtime_health_failed');
        sleep(pollMs);
      }
      if (unit.socketPath !== null) verifyUnixSocketOwner(unit.socketPath, state(unit).pid);
    }
    inspect(plan);
    return receipt(plan, 'healthy');
  }

  function restartEvidence(plan, serviceId, mutationCapability) {
    const unit = units(plan).find(candidate => candidate.id === serviceId);
    if (!unit) fail('runtime_boundary_violation');
    const before = state(unit);
    if (!before.active || before.fragment !== unit.installed
        || !Number.isSafeInteger(before.pid) || before.pid < 1) fail('runtime_health_failed');
    mutateCall(mutationCapability, () => execute([
      'kill', '--kill-whom=main', '--signal=SIGTERM', unit.name,
    ]));
    const after = waitFor(unit, current => {
      if (!current.active || current.pid === before.pid || current.restarts <= before.restarts) return false;
      try { return processArguments(current.pid).includes(unit.expectedProcessArgument); } catch { return false; }
    });
    if (!after.active) fail('runtime_health_failed');
    health(plan);
    return receipt(plan, 'restart_verified', true);
  }

  function boundedRestartEvidence(plan, serviceId, mutationCapability) {
    const selected = units(plan);
    const unit = selected.find(value => value.id === serviceId);
    if (!unit) fail('runtime_boundary_violation');
    inspect(plan);
    const initial = state(unit);
    let current = initial;
    for (let termination = 0; termination < 8 && current.activeState !== 'failed'; termination += 1) {
      const priorPid = current.pid;
      if (current.fragment !== unit.installed) fail('runtime_health_failed');
      mutateCall(mutationCapability, () => execute([
        'kill', '--kill-whom=main', '--signal=SIGTERM', unit.name,
      ]));
      const deadline = clock() + waitTimeoutMs;
      for (;;) {
        current = state(unit);
        if (current.activeState === 'failed') break;
        if (current.active && current.pid !== priorPid) {
          try {
            if (processArguments(current.pid).includes(unit.expectedProcessArgument)) break;
          } catch {}
        }
        if (clock() >= deadline) fail('runtime_health_failed');
        sleep(pollMs);
      }
    }
    if (current.activeState !== 'failed' || current.active
        || current.restarts < initial.restarts
        || current.restarts - initial.restarts > 5) fail('runtime_health_failed');
    return receipt(plan, 'restart_bounded', true);
  }

  return Object.freeze({
    snapshot,
    reload,
    enable,
    disable,
    start,
    stop,
    resetFailed,
    restoreState,
    inspect,
    health,
    restartEvidence,
    boundedRestartEvidence,
  });
}

module.exports = {
  DEFAULT_WAIT_TIMEOUT_MS,
  createSystemdUserSupervisor,
};
