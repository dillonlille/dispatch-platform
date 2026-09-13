'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOciHostHelperClient } = require('../src/oci-host-helper-client');

const CLAIM = Object.freeze({ jobId: 'job_helper', workerId: 'worker_helper', fence: 1, generation: 1 });

test('OCI host-helper client invokes only the fixed privileged executable with one closed request', () => {
  const requests = [];
  const execute = (command, args, options) => {
    assert.equal(command, '/usr/bin/sudo');
    assert.deepEqual(args, ['-n', '/opt/dispatch-control/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-helper']);
    const request = JSON.parse(options.input.slice(0, -1));
    requests.push(request);
    return { status: 0, signal: null, stdout: `${JSON.stringify({ ok: true, result: { status: 'ok' } })}\n`, stderr: '' };
  };
  const client = createOciHostHelperClient({ execute, authorizeRequest: () => 'a'.repeat(64) });
  assert.deepEqual(client.hostRegistry.reserve('runtime_helper', CLAIM), { status: 'ok' });
  let guarded = 0;
  assert.deepEqual(client.hostExecutor.materializeLayout(
    { plan: true },
    'A'.repeat(43),
    CLAIM,
    callback => { guarded += 1; return callback(); },
  ), { status: 'ok' });
  assert.equal(guarded, 1);
  assert.deepEqual(requests.map(value => value.operation), ['reserve_account', 'materialize_layout']);
  assert.equal(requests[1].token, 'A'.repeat(43));
  assert.equal(JSON.stringify(requests[0]).includes('token'), false);
});

test('OCI host-helper client sanitizes helper failures', () => {
  const client = createOciHostHelperClient({
    authorizeRequest: () => 'a'.repeat(64),
    execute: () => ({ status: 0, signal: null, stdout: '{"ok":false,"status":"runtime_boundary_violation"}\n', stderr: '' }),
  });
  assert.throws(() => client.hostRegistry.inspect('runtime_helper', CLAIM),
    error => error.code === 'runtime_boundary_violation' && !JSON.stringify(error).includes('runtime_helper'));
});

test('OCI helper client cannot fall back to caller-generated claims without an authority action', () => {
  let invoked = false;
  assert.throws(() => createOciHostHelperClient({ execute: () => { invoked = true; } }),
    { code: 'runtime_boundary_violation' });
  assert.equal(invoked, false);
});
