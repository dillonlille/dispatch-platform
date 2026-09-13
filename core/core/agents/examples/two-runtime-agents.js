'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseStrictJson } = require('../../../shared/gateway/strict-json');
const {
  CoreRuntimeAgentHub,
  createRuntimeAgentDispatchClient,
} = require('../src');

const CHILD = path.join(__dirname, "./synthetic-runtime-agent.js");
const CHILD_OUTPUT_LIMIT = 4 * 1024;

function token() { return crypto.randomBytes(32).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function startAgent(config) {
  const child = spawn(process.execPath, ['--no-warnings', CHILD], {
    cwd: path.dirname(__dirname),
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('runtime_agent_fixture_failed')), 5_000);
    child.once('error', () => finish(new Error('runtime_agent_fixture_failed')));
    child.stdout.on('data', chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > CHILD_OUTPUT_LIMIT) return finish(new Error('runtime_agent_fixture_failed'));
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      try { finish(null, parseStrictJson(output.subarray(0, newline).toString('utf8'))); }
      catch { finish(new Error('runtime_agent_fixture_failed')); }
    });
    child.once('exit', code => {
      if (!settled && code !== 0) finish(new Error('runtime_agent_fixture_failed'));
    });
  });
  child.stdin.end(`${JSON.stringify(config)}\n`);
  return { child, ready };
}

async function stopAgent(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitFor(check) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('runtime_agent_fixture_failed');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-two-agents-'));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'runtime-agent-hub.sock');
  const alphaToken = token();
  const bravoToken = token();
  const hub = new CoreRuntimeAgentHub({
    socketPath,
    authorities: {
      fixture_alpha: digest(alphaToken),
      fixture_bravo: digest(bravoToken),
    },
  });
  const children = [];
  try {
    await hub.start();
    const alphaAgent = startAgent({
      socketPath, runtimeKey: 'fixture_alpha', registrationToken: alphaToken, label: 'alpha',
    });
    const bravoAgent = startAgent({
      socketPath, runtimeKey: 'fixture_bravo', registrationToken: bravoToken, label: 'bravo',
    });
    children.push(alphaAgent.child, bravoAgent.child);
    const registrations = await Promise.all([alphaAgent.ready, bravoAgent.ready]);
    assert.deepEqual(registrations.map(value => value.status), ['registered', 'registered']);
    assert.deepEqual(hub.status(), { protocolVersion: 1, configured: 2, connected: 2 });

    const alpha = createRuntimeAgentDispatchClient({ hub, runtimeKey: 'fixture_alpha' });
    const bravo = createRuntimeAgentDispatchClient({ hub, runtimeKey: 'fixture_bravo' });
    const [alphaDay, bravoDay] = await Promise.all([
      alpha.workforce.day({ date: '2026-09-03', limit: 10, offset: 0 }),
      bravo.workforce.day({ date: '2026-09-03', limit: 10, offset: 0 }),
    ]);
    assert.equal(alphaDay.data.label, 'alpha');
    assert.equal(bravoDay.data.label, 'bravo');
    assert.equal((await alpha.health()).data.runtimeIdentity, 'matched');
    assert.equal((await bravo.health()).data.runtimeIdentity, 'matched');

    const crossed = startAgent({
      socketPath, runtimeKey: 'fixture_alpha', registrationToken: bravoToken, label: 'crossed',
    });
    children.push(crossed.child);
    assert.equal((await crossed.ready).status, 'runtime_agent_unauthorized');
    await stopAgent(crossed.child);
    assert.equal(hub.status().connected, 2);

    await stopAgent(alphaAgent.child);
    await waitFor(() => !hub.connected('fixture_alpha'));
    assert.equal((await alpha.system.status()).status, 'runtime_agent_unavailable');
    assert.equal((await bravo.system.status()).data.label, 'bravo');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'two_runtime_agents_verified',
      centralCoreHubs: 1,
      runtimeAgents: 2,
      independentProcesses: true,
      outboundConnections: true,
      crossedIdentityRejected: true,
      failureIsolation: true,
      realCredentialsUsed: false,
      productionStateChanged: false,
    })}\n`);
  } finally {
    await Promise.allSettled(children.map(stopAgent));
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, status: error?.code || 'runtime_agent_fixture_failed' })}\n`);
  process.exitCode = 1;
});
