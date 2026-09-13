'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { success } = require('../../../shared/contracts/src');
const { CoreRuntimeAgentControlServer, runtimeAgentControlInvoke } = require('../src/control');

test('owner-private Runtime Agent control socket exposes only closed lifecycle requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-control-'));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'runtime-agent-control.sock');
  const calls = [];
  const server = new CoreRuntimeAgentControlServer({
    socketPath,
    hub: { invoke: async (runtimeKey, action, input) => {
      calls.push({ runtimeKey, action, input });
      return success('found', { desiredState: 'stopped' });
    } },
  });
  try {
    await server.start();
    const result = await runtimeAgentControlInvoke(socketPath, 'runtime_control', 'sync.status', { id: 'paycom_hourly' });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ runtimeKey: 'runtime_control', action: 'sync.status', input: { id: 'paycom_hourly' } }]);
    await assert.rejects(
      runtimeAgentControlInvoke(socketPath, 'runtime_control', 'sync.run_now', { id: 'paycom_hourly', options: {} }),
      error => error.code === 'invalid_request',
    );
    assert.equal(calls.length, 1);
    const workforce = await runtimeAgentControlInvoke(socketPath, 'runtime_control', 'workforce.day',
      { query: { date: '2026-09-05', limit: 1, offset: 0 } });
    assert.equal(workforce.ok, true);
    assert.equal(calls[1].action, 'workforce.day');
    assert.equal(calls[1].input.query.search, null);

    const info = fs.lstatSync(socketPath);
    assert.equal(info.uid, process.geteuid());
    assert.equal(info.mode & 0o7777, 0o600);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
