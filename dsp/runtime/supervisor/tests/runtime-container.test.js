'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  MANAGED_INSTALLATION_LAYOUT_VERSION,
  MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
  managedInstallationRuntimeEnvironment,
} = require('dispatch-protocol/paths/runtime-paths');
const {
  COMPONENTS,
  PROJECT_ROOT,
  CONTAINER_STORAGE_ROOT,
  AGENT_BRIDGE_ROOT,
  configuration,
  definitions,
  assertMountBoundary,
} = require('../src/supervisor');
const { healthyResponse, checkRuntime } = require('../src/health');

function environment() {
  const runtimeKey = 'runtime_container_alpha';
  const runtimeRoot = path.join(CONTAINER_STORAGE_ROOT, runtimeKey);
  const directories = Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
    .map(([field, relative]) => [field, path.join(runtimeRoot, relative)]));
  return {
    DISPATCH_MANAGED_RUNTIME: '1',
    ...managedInstallationRuntimeEnvironment({
      layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION,
      templateId: MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
      runtimeKey,
      projectRoot: PROJECT_ROOT,
      installationRoot: runtimeRoot,
      directories,
    }),
    DISPATCH_RUNTIME_KEY: runtimeKey,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(runtimeRoot, 'run', 'runtime-gateway.sock'),
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: path.join(AGENT_BRIDGE_ROOT, 'runtime-agent-hub.sock'),
    DISPATCH_RUNTIME_AGENT_TOKEN_FILE: path.join(runtimeRoot, 'secrets', 'runtime-agent', 'registration-token'),
    DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: path.join(runtimeRoot, 'run', 'runtime-agent-status.sock'),
    DISPATCH_CHROME_EXECUTABLE: '/usr/bin/chromium',
  };
}

test('container runtime configuration is fixed, closed, and runtime-bound', () => {
  const selected = configuration({ ...environment(), IGNORED_HOST_VALUE: 'not-forwarded' });
  assert.equal(selected.runtimeKey, 'runtime_container_alpha');
  assert.equal(Object.hasOwn(selected.childEnvironment, 'IGNORED_HOST_VALUE'), false);
  assert.deepEqual(definitions(selected).map(item => item.id), COMPONENTS.map(item => item.id));
  assert.equal(definitions(selected).every(item => item.executable === process.execPath), true);
  assert.equal(definitions(selected).every(item => item.arguments.length === 2), true);
  assert.throws(() => configuration({ ...environment(), DISPATCH_LOCAL_ROOT: '/tmp/crossed' }),
    error => error.code === 'runtime_boundary_violation');
  assert.throws(() => configuration({ ...environment(), DISPATCH_RUNTIME_KEY: 'local' }),
    error => error.code === 'runtime_identity_mismatch');
  assert.throws(() => configuration({
    ...environment(), DISPATCH_RUNTIME_AGENT_HUB_SOCKET: '/run/another/hub.sock',
  }), error => error.code === 'runtime_boundary_violation');
});

test('container health accepts only one successful JSON line from all fixed components', () => {
  assert.equal(healthyResponse('{"ok":true,"status":"healthy"}\n'), true);
  assert.equal(healthyResponse('{"ok":true}\n{"ok":true}\n'), false);
  assert.equal(healthyResponse('{"ok":false,"status":"unavailable"}\n'), false);
  const invocations = [];
  const healthy = checkRuntime({
    environment: environment(),
    spawnImpl(executable, args, options) {
      invocations.push({ executable, args, options });
      return { status: 0, signal: null, error: null, stdout: '{"ok":true,"status":"healthy"}\n' };
    },
  });
  assert.equal(healthy, true);
  assert.deepEqual(invocations.map(item => path.basename(item.args[1])), [
    'dispatch-auth-brokerctl', 'dispatch-collectionctl', 'dispatch-runtime-gatewayctl', 'dispatch-runtime-agentctl',
  ]);
  assert.equal(invocations.every(item => item.options.shell === false), true);
  assert.equal(checkRuntime({
    environment: environment(),
    spawnImpl: () => ({ status: 1, signal: null, error: null, stdout: '{"ok":false}\n' }),
  }), false);
});

test('container supervisor requires the read-only image and exact writable/private mounts', () => {
  const config = configuration(environment());
  const mountInfo = [
    '1 0 0:1 / / ro,relatime - overlay overlay ro',
    '2 1 0:2 / /var/lib/dispatch/runtime_container_alpha rw,nosuid,nodev - ext4 state rw',
    '3 1 0:3 / /run/dispatch-agent ro,nosuid,nodev,noexec - ext4 bridge ro',
    '4 1 0:4 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw',
  ].join('\n');
  const absent = () => false;
  assert.equal(assertMountBoundary(config, mountInfo, absent), true);
  assert.throws(() => assertMountBoundary(config, mountInfo.replace(' / ro,', ' / rw,'), absent),
    error => error.code === 'runtime_boundary_violation');
  assert.throws(() => assertMountBoundary(config, `${mountInfo}\n5 1 0:5 / /opt/dispatch rw - ext4 source rw`, absent),
    error => error.code === 'runtime_boundary_violation');
});

test('directory service keeps its backend and trusted browser path in every child', () => {
  const { environment: directoryEnvironment } = require('dispatch-core/host/services/service.js');
  const env = directoryEnvironment('dsp_' + 'a'.repeat(32));
  const config = configuration({ ...env, IGNORED_HOST_VALUE: 'not-forwarded' });
  for (const child of definitions(config)) {
    assert.equal(child.environment.DISPATCH_RUNTIME_BACKEND, 'directory_service_v1');
    assert.equal(child.environment.DISPATCH_CHROME_EXECUTABLE, '/opt/dispatch/dependencies/browser/chrome');
    assert.equal(child.environment.PATH, '/opt/dispatch-tools:/usr/bin:/bin');
    assert.equal(child.environment.IGNORED_HOST_VALUE, undefined);
  }
  assert.throws(() => configuration({ ...env, DISPATCH_CHROME_EXECUTABLE: '/tmp/chrome' }));
  assert.throws(() => directoryEnvironment('../escape'));
});

test('service mounts reject writable source children and executable DSP storage', () => {
  const { environment: directoryEnvironment } = require('dispatch-core/host/services/service.js');
  const env = directoryEnvironment('dsp_' + 'b'.repeat(32));
  const config = configuration(env), root = path.dirname(env.DISPATCH_DATA_ROOT);
  const mounts = [
    '1 0 0:1 / / ro - ext4 root ro',
    `2 1 0:2 / ${root} rw,noexec - ext4 state rw`,
    '3 1 0:3 / /run/dispatch-agent ro,noexec - ext4 bridge ro',
    '4 1 0:4 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw',
    '5 1 0:5 / /opt/dispatch ro - ext4 code ro',
    '6 5 0:6 / /opt/dispatch/protocol ro - ext4 source ro',
    `7 2 0:7 / ${root}/data rw,noexec - ext4 data rw`,
  ].join('\n');
  assert.equal(assertMountBoundary(config, mounts, () => false), true);
  assert.throws(() => assertMountBoundary(config, mounts.replace('/protocol ro', '/protocol rw'), () => false));
  assert.throws(() => assertMountBoundary(config, mounts.replace('/data rw,noexec', '/data rw'), () => false));
  const native = configuration({ ...environment(), DISPATCH_RUNTIME_BACKEND: 'native_service_v1',
    DISPATCH_CHROME_EXECUTABLE: '/opt/dispatch/dependencies/browser/chrome' });
  assert.equal(native.childEnvironment.DISPATCH_RUNTIME_BACKEND, 'native_service_v1');
});
