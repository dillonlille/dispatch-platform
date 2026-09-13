'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { success } = require('dispatch-protocol/contracts/src');
const { RuntimeGatewayServer, createRuntimeGatewayDispatchClient } = require('../src');

function fixtureClient(value) {
  return {
    system: { status: async () => success('ready', {
      value,
      components: {
        auth: { healthy: true, ready: true },
        collections: { healthy: true, ready: true, status: 'ready', data: { manager: { running: true } } },
      },
      summary: { ready: 3, degraded: 0, failed: 0 },
    }) },
    workforce: { day: async query => success('found', { value, date: query.date }) },
    sync: {
      status: async id => success('found', { value, id }),
      runNow: async id => success('queued', { value, id }),
      start: async id => success('started', { value, id }),
      stop: async id => success('stopped', { value, id }),
    },
    collections: { health: async () => success('ready', { value, counts: { queued: 0, running: 0 } }) },
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-gateway-exercise-'));
  fs.chmodSync(root, 0o700);
  const values = [
    { key: 'fixture_alpha', marker: 'alpha' },
    { key: 'fixture_bravo', marker: 'bravo' },
  ];
  const servers = [];
  try {
    for (const value of values) {
      const runtimeRoot = path.join(root, value.marker);
      fs.mkdirSync(runtimeRoot, { mode: 0o700 });
      const socketPath = path.join(runtimeRoot, 'runtime-gateway.sock');
      const server = new RuntimeGatewayServer({
        socketPath,
        runtimeKey: value.key,
        client: fixtureClient(value.marker),
      });
      await server.start();
      servers.push({ server, socketPath, ...value });
    }
    const clients = servers.map(value => createRuntimeGatewayDispatchClient({
      socketPath: value.socketPath,
      runtimeKey: value.key,
    }));
    const results = await Promise.all(clients.map(client => client.system.status()));
    assert.deepEqual(results.map(result => result.data.value), ['alpha', 'bravo']);
    const crossed = createRuntimeGatewayDispatchClient({
      socketPath: servers[1].socketPath,
      runtimeKey: servers[0].key,
    });
    assert.equal((await crossed.system.status()).status, 'runtime_identity_mismatch');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'verified',
      gatewayProtocolVersion: 1,
      fixtures: 2,
      isolated: true,
      crossRouteRejected: true,
    })}\n`);
  } finally {
    await Promise.all(servers.map(value => value.server.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(() => { process.stderr.write('runtime gateway exercise failed\n'); process.exitCode = 1; });
