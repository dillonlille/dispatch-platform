'use strict';

const net = require('node:net');
const { validateCapacityRequest, validateCapacityResponse } = require('../../../shared/agent/capacity');
const { MAX_AGENT_FRAME_BYTES, encodeFrame, attachFrameReader } = require('../../../shared/agent/framing');
const {
  validateRegistrationFrame,
  validateRegisteredFrame,
  validateRejectedFrame,
  validateHeartbeatFrame,
  validateHeartbeatAckFrame,
  validateRequestFrame,
  validateResponseFrame,
} = require('../../../shared/agent/protocol');

const REGISTRATION_TIMEOUT_MS = 5_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 5_000;

function fail(code = 'runtime_agent_bridge_unavailable') {
  throw Object.assign(new Error(code), { code });
}

function validateDownstreamFrame(value, runtimeKey, registered) {
  if (!registered) {
    const frame = validateRegistrationFrame(value);
    if (frame.runtimeKey !== runtimeKey) fail('runtime_identity_mismatch');
    return frame;
  }
  if (value?.type === 'capacity_request') return validateCapacityRequest(value);
  if (value?.type === 'heartbeat_ack') return validateHeartbeatAckFrame(value);
  if (value?.type === 'response') return validateResponseFrame(value);
  fail('invalid_runtime_agent_frame');
}

function validateUpstreamFrame(value, runtimeKey, registered) {
  if (!registered) {
    if (value?.type === 'registered') return Object.freeze({ frame: validateRegisteredFrame(value), registered: true, terminal: false });
    if (value?.type === 'rejected') return Object.freeze({ frame: validateRejectedFrame(value), registered: false, terminal: true });
    fail('invalid_runtime_agent_frame');
  }
  if (value?.type === 'capacity_response') return Object.freeze({ frame: validateCapacityResponse(value), registered: true, terminal: false });
  if (value?.type === 'heartbeat') return Object.freeze({ frame: validateHeartbeatFrame(value), registered: true, terminal: false });
  if (value?.type === 'request') return Object.freeze({ frame: validateRequestFrame(value, runtimeKey), registered: true, terminal: false });
  fail('invalid_runtime_agent_frame');
}

const MAX_BRIDGE_QUEUED_BYTES = MAX_AGENT_FRAME_BYTES * 2;
function writeFrame(socket, frame, source = null) {
  if (socket.destroyed || !socket.writable) fail();
  const encoded = encodeFrame(frame);
  if (socket.writableLength + Buffer.byteLength(encoded) > MAX_BRIDGE_QUEUED_BYTES) fail();
  if (!socket.write(encoded) && source && !source.isPaused()) {
    source.pause();
    socket.once('drain', () => { if (!source.destroyed) source.resume(); });
  }
}

class ForwardingBridge {
  constructor(config) { this.config = config; this.active = null; }

  closeConnection(state) {
    clearTimeout(state.registrationTimer);
    clearTimeout(state.connectTimer);
    if (!state.downstream.destroyed) state.downstream.destroy();
    if (state.upstream && !state.upstream.destroyed) state.upstream.destroy();
    if (this.active === state) this.active = null;
  }

  accept(downstream) {
    if (this.active) return downstream.destroy();
    const state = {
      downstream,
      upstream: null,
      registrationSeen: false,
      registered: false,
      registrationTimer: null,
      connectTimer: null,
    };
    this.active = state;
    const close = () => this.closeConnection(state);
    downstream.on('error', close);
    downstream.on('close', close);
    state.registrationTimer = setTimeout(close, REGISTRATION_TIMEOUT_MS);
    attachFrameReader(downstream, {
      maxFrameBytes: MAX_AGENT_FRAME_BYTES,
      onError: close,
      onFrame: value => {
        try {
          if (!state.registrationSeen) {
            const registration = validateDownstreamFrame(value, this.config.runtimeKey, false);
            state.registrationSeen = true;
            this.validateUpstream();
            const upstream = net.createConnection(this.config.upstreamSocket);
            state.upstream = upstream;
            state.connectTimer = setTimeout(close, UPSTREAM_CONNECT_TIMEOUT_MS);
            upstream.on('error', close);
            upstream.on('close', close);
            attachFrameReader(upstream, {
              maxFrameBytes: MAX_AGENT_FRAME_BYTES,
              onError: close,
              onFrame: upstreamValue => {
                try {
                  const selected = validateUpstreamFrame(upstreamValue, this.config.runtimeKey, state.registered);
                  state.registered = selected.registered;
                  if (state.registered || selected.terminal) clearTimeout(state.registrationTimer);
                  writeFrame(downstream, selected.frame, upstream);
                  if (selected.terminal) downstream.end();
                } catch { close(); }
              },
            });
            upstream.once('connect', () => {
              clearTimeout(state.connectTimer);
              try { writeFrame(upstream, registration, downstream); } catch { close(); }
            });
            return;
          }
          if (!state.registered || !state.upstream) return close();
          writeFrame(state.upstream, validateDownstreamFrame(value, this.config.runtimeKey, true), downstream);
        } catch { close(); }
      },
    });
  }

}

module.exports = { ForwardingBridge, validateDownstreamFrame, validateUpstreamFrame, writeFrame, MAX_BRIDGE_QUEUED_BYTES };
