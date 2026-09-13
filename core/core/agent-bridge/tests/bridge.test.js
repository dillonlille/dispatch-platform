'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { HOST_BRIDGE_ROOT, opaqueRuntimeSuffix } = require('../../runtime-host-identity');
const { RUNTIME_GATEWAY_ACTIONS, gatewayFailure } = require('../../../shared/gateway/protocol');
const {
  RUNTIME_AGENT_PROTOCOL_VERSION,
  registeredFrame,
  rejectedFrame,
  heartbeatFrame,
  heartbeatAckFrame,
  requestFrame,
  responseFrame,
} = require('../../../shared/agent/protocol');
const { configuration } = require('../src/bridge');
const { validateDownstreamFrame, validateUpstreamFrame } = require('../src/forwarding');

const RUNTIME_KEY = 'runtime_bridge_alpha';

function registration(runtimeKey = RUNTIME_KEY) {
  return {
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'register',
    runtimeKey,
    registrationToken: 'a'.repeat(43),
    actions: [...RUNTIME_GATEWAY_ACTIONS],
  };
}

test('bridge configuration derives and pins one DSP endpoint', () => {
  const downstream = path.join(HOST_BRIDGE_ROOT, opaqueRuntimeSuffix(RUNTIME_KEY), 'runtime-agent-hub.sock');
  const value = configuration({
    runtimeKey: RUNTIME_KEY,
    downstreamSocket: downstream,
    upstreamSocket: '/tmp/dispatch-central/runtime-agent-hub.sock',
    tenantUid: process.geteuid() + 1,
    tenantGid: process.getegid() + 1,
    controllerUid: process.geteuid(),
    controllerGid: process.getegid(),
    centralUid: process.geteuid() + 2,
  });
  assert.equal(value.runtimeKey, RUNTIME_KEY);
  assert.equal(value.downstreamSocket, downstream);
  assert.throws(() => configuration({ ...value, downstreamSocket: '/tmp/caller/runtime-agent-hub.sock' }),
    error => error.code === 'runtime_agent_bridge_unavailable');
  assert.throws(() => configuration({ ...value, command: '/bin/sh' }),
    error => error.code === 'runtime_agent_bridge_unavailable');
  assert.throws(() => configuration({ ...value, tenantUid: value.centralUid }),
    error => error.code === 'runtime_agent_bridge_unavailable');
});

test('bridge forwards only the closed Runtime Agent protocol for its pinned identity', () => {
  assert.deepEqual(validateDownstreamFrame(registration(), RUNTIME_KEY, false), registration());
  assert.throws(() => validateDownstreamFrame(registration('runtime_bridge_beta'), RUNTIME_KEY, false),
    error => error.code === 'runtime_identity_mismatch');
  assert.deepEqual(validateDownstreamFrame(heartbeatAckFrame('b'.repeat(32)), RUNTIME_KEY, true),
    heartbeatAckFrame('b'.repeat(32)));
  assert.deepEqual(validateDownstreamFrame(responseFrame('c'.repeat(32), gatewayFailure('runtime_gateway_unavailable')), RUNTIME_KEY, true),
    responseFrame('c'.repeat(32), gatewayFailure('runtime_gateway_unavailable')));
  assert.throws(() => validateDownstreamFrame({ ...heartbeatAckFrame('b'.repeat(32)), extra: true }, RUNTIME_KEY, true),
    error => error.code === 'invalid_runtime_agent_frame');

  assert.deepEqual(validateUpstreamFrame(registeredFrame(), RUNTIME_KEY, false), {
    frame: registeredFrame(), registered: true, terminal: false,
  });
  assert.deepEqual(validateUpstreamFrame(rejectedFrame('runtime_agent_unauthorized'), RUNTIME_KEY, false), {
    frame: rejectedFrame('runtime_agent_unauthorized'), registered: false, terminal: true,
  });
  assert.deepEqual(validateUpstreamFrame(heartbeatFrame('d'.repeat(32)), RUNTIME_KEY, true), {
    frame: heartbeatFrame('d'.repeat(32)), registered: true, terminal: false,
  });
  const request = requestFrame('e'.repeat(32), {
    protocolVersion: 1,
    runtimeKey: RUNTIME_KEY,
    action: 'health',
    input: {},
  });
  assert.deepEqual(validateUpstreamFrame(request, RUNTIME_KEY, true), {
    frame: request, registered: true, terminal: false,
  });
  assert.throws(() => validateUpstreamFrame(requestFrame('f'.repeat(32), {
    protocolVersion: 1,
    runtimeKey: 'runtime_bridge_beta',
    action: 'health',
    input: {},
  }), RUNTIME_KEY, true), error => error.code === 'runtime_identity_mismatch');
});

test('bridge applies backpressure and refuses output beyond its byte bound', () => {
  const { EventEmitter } = require('node:events');
  const { writeFrame, MAX_BRIDGE_QUEUED_BYTES } = require('../src/forwarding');
  const socket = new EventEmitter();
  Object.assign(socket, { destroyed: false, writable: true, writableLength: 0,
    write(value) { this.writableLength += Buffer.byteLength(value); return false; } });
  let paused = false;
  const source = { destroyed: false, isPaused: () => paused, pause() { paused = true; }, resume() { paused = false; } };
  const frame = heartbeatAckFrame('b'.repeat(32));
  writeFrame(socket, frame, source);
  assert.equal(paused, true);
  assert.equal(socket.listenerCount('drain'), 1);
  while (socket.writableLength < MAX_BRIDGE_QUEUED_BYTES) {
    const before = socket.writableLength;
    try { writeFrame(socket, frame, source); }
    catch { assert.equal(socket.writableLength, before); break; }
  }
  assert.ok(socket.writableLength <= MAX_BRIDGE_QUEUED_BYTES);
  assert.equal(socket.listenerCount('drain'), 1);
  socket.writableLength = 0; socket.emit('drain');
  assert.equal(paused, false);
});

test('capacity frames require prior registration and cannot carry another DSP identity', () => {
  const request = { type: 'capacity_request', requestId: 'a'.repeat(32), operation: 'acquire', jobId: 'b'.repeat(32), workers: 2 };
  const response = { type: 'capacity_response', requestId: request.requestId, status: 'granted', workers: 2, leaseMs: 120000 };
  assert.deepEqual(validateDownstreamFrame(request, RUNTIME_KEY, true), request);
  assert.deepEqual(validateUpstreamFrame(response, RUNTIME_KEY, true).frame, response);
  assert.throws(() => validateDownstreamFrame(request, RUNTIME_KEY, false));
  assert.throws(() => validateUpstreamFrame(response, RUNTIME_KEY, false));
  assert.throws(() => validateDownstreamFrame({ ...request, runtimeKey: 'another-dsp' }, RUNTIME_KEY, true));
  assert.throws(() => validateDownstreamFrame({ ...request, workers: 7 }, RUNTIME_KEY, true));
});
