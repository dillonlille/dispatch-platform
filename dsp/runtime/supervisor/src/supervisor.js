'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALLATION_IDENTIFIER_RE } = require('dispatch-protocol/contracts/src');
const { managedRuntimeEnvironmentFromProcess } = require('dispatch-protocol/paths/runtime-paths');

const PROJECT_ROOT = '/opt/dispatch';
const CONTAINER_STORAGE_ROOT = '/var/lib/dispatch';
const AGENT_BRIDGE_ROOT = '/run/dispatch-agent';
const STOP_GRACE_MS = 20_000;
const serviceBackend = value => ['native_service_v1', 'directory_service_v1'].includes(value);
const FORBIDDEN_ENVIRONMENT = Object.freeze([
  'DISPATCH_LOCAL_ROOT',
  'DISPATCH_ACCESS_CONTROL_DATABASE_ROOT',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);
const COMPONENTS = Object.freeze([
  Object.freeze({ id: 'auth_broker', relative: 'runtime/auth-broker/bin/dispatch-auth-broker' }),
  Object.freeze({ id: 'collection_manager', relative: 'runtime/collection-manager/bin/dispatch-collection-manager' }),
  Object.freeze({ id: 'runtime_gateway', relative: 'runtime/gateway/bin/dispatch-runtime-gateway' }),
  Object.freeze({ id: 'runtime_agent', relative: 'runtime/agent/bin/dispatch-runtime-agent' }),
]);

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail();
  return value;
}

function configuration(environment = process.env) {
  if (!environment || typeof environment !== 'object') fail();
  if (FORBIDDEN_ENVIRONMENT.some(key => Object.hasOwn(environment, key))) fail();
  const runtimeKey = environment.DISPATCH_RUNTIME_KEY;
  if (typeof runtimeKey !== 'string' || runtimeKey === 'local'
      || !INSTALLATION_IDENTIFIER_RE.test(runtimeKey)) fail('runtime_identity_mismatch');
  const managed = managedRuntimeEnvironmentFromProcess(environment);
  const installationRoot = path.dirname(managed.DISPATCH_DATA_ROOT);
  if (managed.DISPATCH_PROJECT_ROOT !== PROJECT_ROOT
      || path.dirname(installationRoot) !== CONTAINER_STORAGE_ROOT
      || path.basename(installationRoot) !== runtimeKey) fail('runtime_identity_mismatch');
  const gatewaySocket = absolute(environment.DISPATCH_RUNTIME_GATEWAY_SOCKET);
  const hubSocket = absolute(environment.DISPATCH_RUNTIME_AGENT_HUB_SOCKET);
  const tokenFile = absolute(environment.DISPATCH_RUNTIME_AGENT_TOKEN_FILE);
  const statusSocket = absolute(environment.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET);
  if (gatewaySocket !== path.join(managed.DISPATCH_RUNTIME_ROOT, 'runtime-gateway.sock')
      || tokenFile !== path.join(managed.DISPATCH_SECRETS_ROOT, 'runtime-agent', 'registration-token')
      || statusSocket !== path.join(managed.DISPATCH_RUNTIME_ROOT, 'runtime-agent-status.sock')
      || hubSocket !== path.join(AGENT_BRIDGE_ROOT, 'runtime-agent-hub.sock')
      || environment.DISPATCH_CHROME_EXECUTABLE !== (serviceBackend(environment.DISPATCH_RUNTIME_BACKEND)
        ? '/opt/dispatch/dependencies/browser/chrome' : '/usr/bin/chromium')) fail();
  const childEnvironment = Object.freeze({
    HOME: serviceBackend(environment.DISPATCH_RUNTIME_BACKEND) ? '/tmp/dispatch-home' : '/home/dispatch',
    PATH: environment.DISPATCH_RUNTIME_BACKEND === 'directory_service_v1' ? '/opt/dispatch-tools:/usr/bin:/bin'
      : environment.DISPATCH_RUNTIME_BACKEND === 'native_service_v1' ? '/opt/dispatch/dependencies/node/bin:/usr/bin:/bin' : '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_NO_WARNINGS: '1',
    DISPATCH_MANAGED_RUNTIME: '1',
    ...managed,
    DISPATCH_RUNTIME_KEY: runtimeKey,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: gatewaySocket,
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: hubSocket,
    DISPATCH_RUNTIME_AGENT_TOKEN_FILE: tokenFile,
    DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: statusSocket,
    DISPATCH_CHROME_EXECUTABLE: environment.DISPATCH_CHROME_EXECUTABLE,
    ...(serviceBackend(environment.DISPATCH_RUNTIME_BACKEND) ? { DISPATCH_RUNTIME_BACKEND: environment.DISPATCH_RUNTIME_BACKEND } : {}),
    ...(environment.DISPATCH_PLUGIN_BACKEND === 'core_v1' ? { DISPATCH_PLUGIN_BACKEND: 'core_v1' } : {}),
  });
  return Object.freeze({ runtimeKey, childEnvironment });
}

function definitions(config) {
  if (!config || config.childEnvironment?.DISPATCH_PROJECT_ROOT !== PROJECT_ROOT) fail();
  let components = config.childEnvironment.DISPATCH_RUNTIME_BACKEND === 'directory_service_v1'
    ? [{ id: 'egress_relay', relative: 'runtime/supervisor/src/egress-relay.js' }, ...COMPONENTS] : COMPONENTS;
  if (config.childEnvironment.DISPATCH_PLUGIN_BACKEND === 'core_v1') components = components.filter(item => item.id !== 'auth_broker');
  return Object.freeze(components.map(component => Object.freeze({
    id: component.id,
    executable: process.execPath,
    arguments: Object.freeze(['--no-warnings', path.join(PROJECT_ROOT, component.relative)]),
    workingDirectory: path.dirname(path.join(PROJECT_ROOT, component.relative)),
    environment: config.childEnvironment,
  })));
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function assertMountBoundary(config, mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8'), exists = fs.existsSync) {
  if (!config?.childEnvironment || typeof mountInfo !== 'string'
      || Buffer.byteLength(mountInfo, 'utf8') > 4 * 1024 * 1024 || typeof exists !== 'function') fail();
  const mounts = mountInfo.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.split(' ');
    if (fields.indexOf('-') < 6) fail();
    return { point: decodeMountPath(fields[4]), options: new Set(fields[5].split(',')) };
  });
  const exact = point => mounts.find(mount => mount.point === point);
  const runtimeRoot = path.dirname(config.childEnvironment.DISPATCH_DATA_ROOT);
  const root = exact('/');
  const runtime = exact(runtimeRoot);
  const bridge = exact(AGENT_BRIDGE_ROOT);
  const temporary = exact('/tmp');
  if (!root?.options.has('ro') || !runtime?.options.has('rw') || !bridge?.options.has('ro')
      || !temporary?.options.has('rw') || !temporary.options.has('noexec')
      || !temporary.options.has('nosuid') || !temporary.options.has('nodev')) fail();
  if (serviceBackend(config.childEnvironment.DISPATCH_RUNTIME_BACKEND)) {
    if (!exact(PROJECT_ROOT)?.options.has('ro')
        || mounts.some(mount => mount.point.startsWith(`${PROJECT_ROOT}/`) && !mount.options.has('ro'))) fail();
    if (config.childEnvironment.DISPATCH_RUNTIME_BACKEND === 'directory_service_v1'
        && mounts.some(mount => (mount.point === runtimeRoot || mount.point.startsWith(`${runtimeRoot}/`))
          && !mount.options.has('noexec'))) fail();
  } else if (mounts.some(mount => mount.point === PROJECT_ROOT || mount.point.startsWith(`${PROJECT_ROOT}/`))) fail();
  for (const socket of ['/run/podman/podman.sock', '/var/run/docker.sock']) {
    if (!exists(socket)) continue;
    if (!serviceBackend(config.childEnvironment.DISPATCH_RUNTIME_BACKEND)) fail();
    let accessible = false;
    try { fs.accessSync(socket, fs.constants.R_OK | fs.constants.W_OK); accessible = true; } catch {}
    if (accessible) fail();
  }
  return true;
}

function createSupervisor({ environment = process.env, spawnImpl = spawn, stopGraceMs = STOP_GRACE_MS } = {}) {
  if (typeof spawnImpl !== 'function' || !Number.isSafeInteger(stopGraceMs)
      || stopGraceMs < 1 || stopGraceMs > STOP_GRACE_MS) fail();
  const config = configuration(environment);
  const selected = definitions(config);
  const children = new Map();
  let stopping = false;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });

  function signalGroup(child, signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch {} }
  }

  async function stop(exitCode) {
    if (stopping) return stopped;
    stopping = true;
    for (const child of children.values()) signalGroup(child, 'SIGTERM');
    const deadline = Date.now() + stopGraceMs;
    while (children.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const child of children.values()) signalGroup(child, 'SIGKILL');
    while (children.size > 0) await new Promise(resolve => setTimeout(resolve, 10));
    resolveStopped(exitCode);
    return stopped;
  }

  function start() {
    for (const definition of selected) {
      let child;
      try {
        child = spawnImpl(definition.executable, [...definition.arguments], {
          cwd: definition.workingDirectory,
          env: definition.environment,
          detached: true,
          shell: false,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
      } catch {
        stop(1).catch(() => {});
        break;
      }
      children.set(definition.id, child);
      child.once('error', () => { stop(1).catch(() => {}); });
      child.once('close', code => {
        children.delete(definition.id);
        if (!stopping) stop(code === 0 ? 1 : code || 1).catch(() => {});
      });
    }
    if (!stopping && children.size !== selected.length) stop(1).catch(() => {});
    return stopped;
  }

  return Object.freeze({
    config,
    definitions: selected,
    start,
    stop,
    childCount: () => children.size,
  });
}

async function main() {
  process.umask(0o077);
  if (process.geteuid() === 0) return 1;
  let supervisor;
  try {
    supervisor = createSupervisor();
    assertMountBoundary(supervisor.config);
    if (serviceBackend(supervisor.config.childEnvironment.DISPATCH_RUNTIME_BACKEND)) {
      fs.mkdirSync(supervisor.config.childEnvironment.HOME, { recursive: true, mode: 0o700 });
    }
  }
  catch { return 1; }
  process.once('SIGTERM', () => { supervisor.stop(0).catch(() => {}); });
  process.once('SIGINT', () => { supervisor.stop(0).catch(() => {}); });
  return supervisor.start();
}

if (require.main === module) main().then(code => { process.exitCode = Number.isInteger(code) ? code : 1; });

module.exports = {
  PROJECT_ROOT,
  CONTAINER_STORAGE_ROOT,
  AGENT_BRIDGE_ROOT,
  COMPONENTS,
  STOP_GRACE_MS,
  configuration,
  definitions,
  assertMountBoundary,
  createSupervisor,
  main,
};
