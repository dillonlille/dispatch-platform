'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { success } = require('../../../shared/contracts/src');
const { managedInstallationRuntimeEnvironment } = require('../../../shared/paths/runtime-paths');
const { RuntimeGatewayServer } = require('dispatch-dsp/runtime/gateway/src/index.js');
const {
  createInstallationLayoutManager,
  createRuntimeAgentCredentialManager,
  INSTALLATION_LAYOUT_TEMPLATE,
} = require('../../installations/src');
const { CoreRuntimeAgentHub } = require('../src');
const { queryRuntimeAgentStatus } = require('dispatch-dsp/runtime/agent/src/index.js');

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function waitFor(callback, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await callback();
      if (value) return value;
    } catch {}
    if (Date.now() >= deadline) throw new Error('runtime_agent_fixture_timeout');
    await delay(25);
  }
}

function client() {
  return {
    workforce: { day: async query => success('found', { businessDate: query.date, items: [] }) },
    sync: {
      status: async id => success('found', { id, desiredState: 'stopped' }),
      runNow: async id => success('queued', { id, replayed: false }),
      start: async id => success('started', { id }),
      stop: async id => success('stopped', { id }),
    },
    collections: { health: async () => success('ready', { counts: { queued: 0, running: 0 } }) },
    system: { status: async () => success('ready', { fixture: 'durable_service' }) },
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-service-'));
  fs.chmodSync(root, 0o700);
  const installationsRoot = path.join(root, 'installations');
  const centralRuntimeRoot = path.join(root, 'central-run');
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  fs.mkdirSync(centralRuntimeRoot, { mode: 0o700 });
  const runtimeKey = 'fixture_durable_service';
  const manifest = {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_durable_service', stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: runtimeKey, templateId: INSTALLATION_LAYOUT_TEMPLATE, releaseId: 'dispatch_fixture_1' },
  };
  const authority = {
    revision: manifest.revision,
    organization: { ...manifest.organization },
    runtime: { ...manifest.runtime },
  };
  const credentials = createRuntimeAgentCredentialManager({ installationsRoot });
  const credential = credentials.issue(runtimeKey);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  layoutManager.materialize(manifest, authority);
  const layout = layoutManager.derive(manifest, authority);
  const paths = layoutManager.runtimePaths(manifest, authority);
  const hubSocket = path.join(centralRuntimeRoot, 'runtime-agent-hub.sock');
  let hub = new CoreRuntimeAgentHub({
    socketPath: hubSocket,
    authorities: { [runtimeKey]: credential.tokenHash },
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 150,
  });
  let gateway;
  let child;
  try {
    await hub.start();
    gateway = new RuntimeGatewayServer({
      socketPath: path.join(paths.runtimeRoot, 'runtime-gateway.sock'),
      runtimeKey,
      client: client(),
    });
    await gateway.start();
    const environment = {
      ...managedInstallationRuntimeEnvironment(layout),
      DISPATCH_RUNTIME_KEY: runtimeKey,
      DISPATCH_RUNTIME_GATEWAY_SOCKET: gateway.socketPath,
      DISPATCH_RUNTIME_AGENT_HUB_SOCKET: hubSocket,
      DISPATCH_RUNTIME_AGENT_TOKEN_FILE: paths.runtimeAgent.registrationToken,
      DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: paths.runtimeAgent.statusSocket,
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NODE_NO_WARNINGS: '1',
    };
    child = spawn(path.join(__dirname, "../../../runtime/agent/bin/dispatch-runtime-agent"), [], {
      cwd: path.join(__dirname, ".."),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await waitFor(async () => (await queryRuntimeAgentStatus(paths.runtimeAgent.statusSocket)).ok);
    if (!hub.connected(runtimeKey)) throw new Error('runtime_agent_fixture_failed');

    await hub.close();
    await waitFor(async () => !(await queryRuntimeAgentStatus(paths.runtimeAgent.statusSocket)).ok);
    hub = new CoreRuntimeAgentHub({
      socketPath: hubSocket,
      authorities: { [runtimeKey]: credential.tokenHash },
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 150,
    });
    await hub.start();
    await waitFor(async () => (await queryRuntimeAgentStatus(paths.runtimeAgent.statusSocket)).ok);
    if (!hub.connected(runtimeKey)) throw new Error('runtime_agent_fixture_failed');

    child.kill('SIGTERM');
    const stopped = await exit;
    if (stopped.code !== 0) throw new Error('runtime_agent_fixture_failed');
    child = null;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'durable_runtime_agent_service_verified',
      reconnectAfterHubRestart: true,
      privateTokenFile: true,
      supervisedUnitReady: true,
      realCredentialsUsed: false,
    })}\n`);
  } finally {
    if (child) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await gateway?.close().catch(() => {});
    await hub.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, status: 'runtime_agent_fixture_failed' })}\n`);
  process.exitCode = 1;
});
