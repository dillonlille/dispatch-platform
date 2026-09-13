'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireAuthenticatedBrowser, AuthenticatedBrowserLease, loopbackEndpoint, publicSession,
} = require('../src/browser-client');

function session(overrides = {}) {
  return {
    profile: 'paycom-main', provider: 'paycom', collector: 'paycom', runId: 'run_fixture', status: 'ready',
    acquiredAt: '2026-08-29T00:00:00.000Z', expiresAt: '2026-08-29T00:01:30.000Z',
    lease: 'A'.repeat(43), browser: { protocol: 'cdp', endpoint: 'http://127.0.0.1:9222', access: 'full' },
    ...overrides,
  };
}

test('browser acquisition maps unavailable socket details to a stable broker error', async () => {
  const socketPath = path.join(os.tmpdir(), `dispatch-missing-broker-${process.pid}.sock`);
  await assert.rejects(acquireAuthenticatedBrowser({
    profile: 'paycom-main',
    collector: 'paycom',
    runId: 'run_transport_mapping',
    ttlSeconds: 90,
    socketPath,
  }), error => error.code === 'broker_unavailable' && error.message === 'broker_unavailable');
});

test('browser acquisition forwards caller cancellation as a stable code', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireAuthenticatedBrowser({
    profile: 'amazon-operations',
    collector: 'cdf',
    runId: 'run_cancelled',
    ttlSeconds: 90,
    socketPath: path.join(os.tmpdir(), `dispatch-unused-broker-${process.pid}.sock`),
    signal: controller.signal,
  }), error => error.code === 'acquisition_cancelled');
});

test('browser acquisition preserves a closed broker invalid-input status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-browser-client-'));
  const socketPath = path.join(root, 'broker.sock');
  const server = net.createServer(socket => {
    socket.once('data', () => socket.end('{"ok":false,"status":"invalid_input"}\n'));
  });
  try {
    await new Promise((resolve, reject) => server.listen(socketPath, error => error ? reject(error) : resolve()));
    await assert.rejects(acquireAuthenticatedBrowser({
      profile: 'amazon-operations', collector: 'cdf', runId: 'run_invalid', ttlSeconds: 90, socketPath,
    }), error => error.code === 'invalid_input');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated browser lease accepts only a closed loopback CDP session', () => {
  const lease = new AuthenticatedBrowserLease({ socketPath: '/tmp/fixture.sock', session: session() });
  assert.equal(lease.endpoint, 'http://127.0.0.1:9222');
  assert.equal(lease.lease, 'A'.repeat(43));
  assert.throws(() => new AuthenticatedBrowserLease({
    socketPath: '/tmp/fixture.sock', session: session({ browser: { protocol: 'cdp', endpoint: 'https://example.com:9222', access: 'full' } }),
  }), error => error.code === 'invalid_response');
  assert.throws(() => new AuthenticatedBrowserLease({
    socketPath: '/tmp/fixture.sock', session: { ...session(), injected: 'private' },
  }), error => error.code === 'invalid_response');
  assert.throws(() => loopbackEndpoint('http://user:pass@127.0.0.1:9222/private?token=value'), error => error.code === 'invalid_response');
});

test('browser session status DTOs reject unknown fields and malformed identities', () => {
  const metadata = Object.fromEntries(Object.entries(session()).filter(([key]) => !['lease', 'browser'].includes(key)));
  assert.deepEqual(publicSession(metadata), metadata);
  assert.throws(() => publicSession({ ...metadata, endpoint: 'http://127.0.0.1:9222' }), error => error.code === 'invalid_response');
  assert.throws(() => publicSession({ ...metadata, runId: 'bad run id' }), error => error.code === 'invalid_response');
});
