'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  MANAGED_INSTALLATION_LAYOUT_VERSION,
  MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
  managedInstallationRuntimeEnvironment,
} = require('dispatch-protocol/paths/runtime-paths');
const { CoreRuntimeAgentHub, createRuntimeAgentDispatchClient } = require('dispatch-core/core/agents/src/index.js');

const IMAGE = 'localhost/dispatch-runtime:dev';
const RUNTIME_KEY = 'runtime_container_fixture';
const CONTAINER = `dispatch-runtime-container-fixture-${process.pid}`;
const GUEST_ROOT = `/var/lib/dispatch/${RUNTIME_KEY}`;
const MAX_OUTPUT = 64 * 1024;
let currentPhase = 'preflight';
let lastDiagnostic = '';

function fail(code = 'runtime_container_fixture_failed', diagnostic = '') {
  throw Object.assign(new Error(code), { code, diagnostic });
}

function command(args, { timeout = 30_000, allowFailure = false } = {}) {
  const result = spawnSync('/usr/bin/podman', args, {
    encoding: 'utf8', timeout, shell: false,
    env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.geteuid()}` },
    maxBuffer: MAX_OUTPUT,
  });
  if (!allowFailure && (result.error || result.signal || result.status !== 0)) fail();
  return result;
}

function runtimeLayout(installationRoot, projectRoot) {
  const directories = Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
    .map(([field, relative]) => [field, path.join(installationRoot, relative)]));
  return Object.freeze({
    layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION,
    templateId: MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
    runtimeKey: RUNTIME_KEY,
    projectRoot,
    installationRoot,
    directories: Object.freeze(directories),
  });
}

function materialize(layout) {
  fs.mkdirSync(layout.installationRoot, { mode: 0o700 });
  const selected = [...new Set(Object.values(layout.directories))]
    .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
  for (const directory of selected) fs.mkdirSync(directory, { mode: 0o700 });
  return layout.directories.runtimeAgentSecretsRoot;
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail();
}

function childExit(child) {
  return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('runtime_container_fixture_failed'), {
          code: 'runtime_container_fixture_failed',
        })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  process.umask(0o077);
  if (process.geteuid() === 0) fail();
  if (command(['container', 'exists', CONTAINER], { allowFailure: true }).status === 0) fail('fixture_preexisting');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-container-'));
  const hostRoot = path.join(fixtureRoot, RUNTIME_KEY);
  const bridgeRoot = path.join(fixtureRoot, 'bridge');
  const hostLayout = runtimeLayout(hostRoot, path.resolve(__dirname, "../../.."));
  const guestLayout = runtimeLayout(GUEST_ROOT, '/opt/dispatch');
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenDigest = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  let hub;
  let container;
  let containerOutput = '';
  try {
    currentPhase = 'materialize';
    const tokenRoot = materialize(hostLayout);
    fs.writeFileSync(path.join(tokenRoot, 'registration-token'), `${token}\n`, { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(bridgeRoot, { mode: 0o700 });
    const hubSocket = path.join(bridgeRoot, 'runtime-agent-hub.sock');
    currentPhase = 'hub_start';
    hub = new CoreRuntimeAgentHub({
      socketPath: hubSocket,
      authorities: { [RUNTIME_KEY]: tokenDigest },
      heartbeatIntervalMs: 250,
      heartbeatTimeoutMs: 2_000,
    });
    await hub.start();

    const environment = {
      ...managedInstallationRuntimeEnvironment(guestLayout),
      DISPATCH_RUNTIME_KEY: RUNTIME_KEY,
      DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(GUEST_ROOT, 'run', 'runtime-gateway.sock'),
      DISPATCH_RUNTIME_AGENT_TOKEN_FILE: path.join(GUEST_ROOT, 'secrets', 'runtime-agent', 'registration-token'),
      DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: path.join(GUEST_ROOT, 'run', 'runtime-agent-status.sock'),
    };
    const args = [
      'run', '--rm', '--name', CONTAINER,
      '--label', 'io.dispatch.fixture=runtime-container-v1',
      '--pull=never', '--http-proxy=false', '--network=none', '--pid=private', '--ipc=private', '--uts=private', '--read-only',
      '--user', '10001:10001', '--userns', 'keep-id:uid=10001,gid=10001',
      '--cap-drop', 'ALL', '--cap-add', 'SYS_CHROOT', '--security-opt', 'no-new-privileges',
      '--memory', '4g', '--cpus', '2', '--pids-limit', '512', '--shm-size', '512m',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777',
      '--volume', `${hostRoot}:${GUEST_ROOT}:rw,rprivate,nosuid,nodev`,
      '--volume', `${bridgeRoot}:/run/dispatch-agent:ro,rprivate,nosuid,nodev,noexec`,
    ];
    for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(IMAGE);
    currentPhase = 'container_start';
    container = spawn('/usr/bin/podman', args, {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.geteuid()}` },
    });
    const exited = childExit(container);
    for (const stream of [container.stdout, container.stderr]) stream.on('data', chunk => {
      containerOutput += chunk.toString('utf8');
      lastDiagnostic = containerOutput.slice(-2048);
      if (Buffer.byteLength(containerOutput, 'utf8') > MAX_OUTPUT) container.kill('SIGKILL');
    });

    currentPhase = 'agent_connect';
    await waitFor(() => hub.connected(RUNTIME_KEY));
    currentPhase = 'collector_definition';
    const applied = command([
      'exec', CONTAINER, '/usr/local/bin/node', '--no-warnings',
      '/opt/dispatch/runtime/collection-manager/bin/dispatch-collectionctl',
      'apply', '/opt/dispatch/plugins/paycom/backend/config/collection-manager.json',
    ], { allowFailure: true });
    if (applied.status !== 0 || JSON.parse(applied.stdout.trim())?.ok !== true) {
      const probe = command([
        'exec', CONTAINER, '/usr/local/bin/node', '--no-warnings', '-e',
        'const fs=require("node:fs");const p="/opt/dispatch/plugins/paycom/backend/bin/dispatch-paycom-collector";const s=fs.lstatSync(p);console.log(JSON.stringify({uid:process.geteuid(),owner:s.uid,mode:s.mode&4095,link:s.nlink,real:fs.realpathSync(p)===p}));',
      ], { allowFailure: true });
      fail('runtime_container_fixture_failed', JSON.stringify({
        status: applied.status, output: applied.stdout.trim(), error: applied.stderr.trim(), probe: probe.stdout.trim(),
      }));
    }
    currentPhase = 'system_status';
    const systemStatus = await createRuntimeAgentDispatchClient({ hub, runtimeKey: RUNTIME_KEY }).system.status();
    if (!systemStatus?.ok) fail();
    currentPhase = 'container_health';
    const health = command(['healthcheck', 'run', CONTAINER], { allowFailure: true });
    if (health.status !== 0) {
      const checks = [
        ['runtime/auth-broker/bin/dispatch-auth-brokerctl', 'health'],
        ['runtime/collection-manager/bin/dispatch-collectionctl', 'status'],
        ['runtime/gateway/bin/dispatch-runtime-gatewayctl', 'health'],
        ['runtime/agent/bin/dispatch-runtime-agentctl', 'health'],
      ].map(([relative, action]) => {
        const result = command([
          'exec', CONTAINER, '/usr/local/bin/node', '--no-warnings', `/opt/dispatch/${relative}`, action,
        ], { allowFailure: true });
        return { component: path.basename(relative), status: result.status, output: result.stdout.trim() };
      });
      fail('runtime_container_fixture_failed', JSON.stringify(checks));
    }
    const healthOutput = command([
      'exec', CONTAINER, '/usr/local/bin/node', '--no-warnings',
      '/opt/dispatch/runtime/supervisor/src/health.js',
    ]);
    const healthValue = JSON.parse(healthOutput.stdout.trim());
    if (!healthValue.ok || healthValue.status !== 'healthy' || healthValue.components !== 4) fail();

    currentPhase = 'paycom_enrollment';
    const enrollment = {
      command: 'enroll', requestId: `setup_${'a'.repeat(32)}`, expiresAt: Date.now() + 30_000, intent: 'create',
      credentials: { clientCode: 'synthetic-client', username: 'synthetic-user', password: 'synthetic-enrollment-secret',
        pin1: 'fixture-one', pin2: 'fixture-two', pin3: 'fixture-three', pin4: 'fixture-four', pin5: 'fixture-five' },
    };
    const enrolled = await hub.invoke(RUNTIME_KEY, 'paycom.setup', enrollment);
    if (!enrolled.ok || enrolled.status !== 'succeeded' || enrolled.data?.configured !== true) {
      fail('runtime_container_fixture_failed', JSON.stringify({ phase: currentPhase, status: enrolled.status }));
    }
    const replay = await hub.invoke(RUNTIME_KEY, 'paycom.setup', enrollment);
    if (!replay.ok || replay.status !== 'succeeded') fail();
    const vaultCheck = command(['exec', CONTAINER, '/usr/local/bin/node', '--no-warnings', '-e',
      'const fs=require("node:fs"),path=require("node:path");const c=require("/opt/dispatch/runtime/gateway/src/managed-runtime").managedRuntimeConfiguration();const files=fs.readdirSync(c.paths.auth.databaseRoot);if(files.some(n=>fs.readFileSync(path.join(c.paths.auth.databaseRoot,n)).includes(Buffer.from("synthetic-enrollment-secret"))))process.exit(1);process.stdout.write("encrypted\\n");',
    ]);
    if (vaultCheck.status !== 0) fail();

    currentPhase = 'paycom_configuration';
    const setupManifest = { manifestVersion: 1, revision: 1,
      organization: { id: 'org_container_setup', stationCode: 'TST1', timezone: 'America/Chicago' },
      runtime: { key: RUNTIME_KEY, templateId: 'isolated_dsp_v1', releaseId: 'dispatch_current_1' } };
    const configureRequest = { command: 'start', requestId: `setup_${'a'.repeat(32)}`, step: 'configure',
      manifest: setupManifest, manifestAuthority: { revision: 1, organization: setupManifest.organization, runtime: setupManifest.runtime }, parameters: {} };
    let configured = await hub.invoke(RUNTIME_KEY, 'paycom.setup', configureRequest);
    const configureDeadline = Date.now() + 30_000;
    while (configured.ok && configured.status === 'running' && Date.now() < configureDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      configured = await hub.invoke(RUNTIME_KEY, 'paycom.setup', { ...configureRequest, command: 'status' });
    }
    if (!configured.ok || configured.status !== 'succeeded' || configured.data?.plans !== 15) {
      fail('runtime_container_fixture_failed', JSON.stringify({ phase: currentPhase, status: configured.status }));
    }

    currentPhase = 'container_inspect';
    const inspect = JSON.parse(command(['inspect', CONTAINER]).stdout)[0];
    if (inspect?.Config?.User !== '10001:10001' || inspect?.HostConfig?.ReadonlyRootfs !== true
        || inspect?.HostConfig?.NetworkMode !== 'none' || inspect?.HostConfig?.PidsLimit !== 512
        || inspect?.HostConfig?.PidMode !== 'private' || inspect?.HostConfig?.IpcMode !== 'private'
        || inspect?.HostConfig?.UTSMode !== 'private'
        || inspect?.HostConfig?.Memory !== 4 * 1024 * 1024 * 1024 || inspect?.HostConfig?.NanoCpus !== 2_000_000_000
        || inspect?.HostConfig?.ShmSize !== 512 * 1024 * 1024
        || JSON.stringify(inspect?.HostConfig?.SecurityOpt) !== JSON.stringify(['no-new-privileges'])
        || !inspect?.HostConfig?.Tmpfs?.['/tmp']?.includes('noexec')
        || JSON.stringify(inspect?.EffectiveCaps || []) !== JSON.stringify(['CAP_SYS_CHROOT'])) fail();
    const destinations = (inspect?.Mounts || []).map(item => item.Destination).sort();
    if (JSON.stringify(destinations) !== JSON.stringify([GUEST_ROOT, '/run/dispatch-agent'].sort())) fail();

    currentPhase = 'browser';
    const browser = command([
      'exec', '--env', 'HOME=/tmp/browser-profile', CONTAINER,
      '/usr/bin/chromium', '--headless=new', '--disable-gpu', '--user-data-dir=/tmp/browser-profile', '--dump-dom', 'about:blank',
    ], { timeout: 30_000 });
    if (!/<html/i.test(browser.stdout) || browser.stdout.includes('--no-sandbox')) fail();
    command([
      'exec', '--detach', '--env', 'HOME=/tmp/dispatch-sandbox-proof', CONTAINER,
      '/usr/bin/chromium', '--headless=new', '--disable-gpu',
      '--user-data-dir=/tmp/dispatch-sandbox-proof', '--remote-debugging-port=0', 'about:blank',
    ]);
    await waitFor(() => {
      const result = command([
        'exec', CONTAINER, '/usr/local/bin/node', '--no-warnings',
        '/opt/dispatch/runtime/supervisor/src/chromium-sandbox-status.js',
      ], { allowFailure: true });
      if (result.status !== 0) return false;
      const value = JSON.parse(result.stdout.trim());
      return value.ok === true && value.status === 'sandboxed';
    }, 20_000);
    command(['exec', CONTAINER, '/usr/bin/pkill', '-TERM', '-f', 'user-data-dir=/tmp/dispatch-sandbox-proof']);

    currentPhase = 'fail_fast';
    command(['exec', CONTAINER, '/usr/bin/pkill', '-TERM', '-f', 'auth-broker/bin/dispatch-auth-broker']);
    const terminal = await withTimeout(exited, 20_000);
    container = null;
    if (terminal.code === 0 || terminal.signal) fail();
    const absent = command(['container', 'exists', CONTAINER], { allowFailure: true });
    if (absent.status === 0) fail();

  } finally {
    if (container) {
      command(['stop', '--time', '5', CONTAINER], { allowFailure: true });
      command(['rm', '--force', '--ignore', CONTAINER], { allowFailure: true });
    }
    try { await hub?.close(); } catch {}
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  if (command(['container', 'exists', CONTAINER], { allowFailure: true }).status === 0 || fs.existsSync(fixtureRoot)) {
    fail('runtime_container_fixture_cleanup_failed');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'runtime_container_fixture_verified',
    services: 4,
    outboundAgent: true,
    readOnlyRoot: true,
    paycomEnrollment: true,
    browserSandbox: true,
    failFast: true,
    artifactsRemaining: 0,
  })}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    status: error?.code || 'runtime_container_fixture_failed',
    phase: currentPhase,
    diagnostic: String(error?.diagnostic || lastDiagnostic).replace(/[A-Za-z0-9_-]{43}/g, '[redacted]'),
  })}\n`);
  process.exitCode = 1;
});

module.exports = { main };
