'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { coreHooks } = require('../../../host/releases/core');
const { requestHealth } = require('../../../host/releases/health');
const { atomic } = require('../../installations/src/release-delivery-files');
async function server(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
test('Core loopback health preserves public Host, HTTPS forwarding and recovery nonce', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-core-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { mode: 0o700 });
  atomic(path.join(root, 'config/dashboard.json'), { version: 1, port: 4310, publicOrigin: 'https://dispatch.example.test' });
  const digest = 'a'.repeat(64), nonce = 'b'.repeat(64); let requests = 0;
  const port = await server(t, (request, response) => {
    requests++;
    const allowed = request.headers.host === 'dispatch.example.test' && request.headers['cf-visitor'] === '{"scheme":"https"}'
      && request.headers['x-dispatch-recovery-probe'] === nonce;
    response.writeHead(allowed ? 200 : 403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: allowed, data: { digest, version: '0.0.2', recoveryProbe: 'passed' } }));
  });
  const hooks = coreHooks({ paths: { local: root, platformRoot: root }, configuration: { apiPort: port }, releases: () => ({}), healthTimeoutMs: 1000 });
  assert.equal(await hooks.verify({ digest, manifest: { version: '0.0.2' }, preparation: { nonce } }), true);
  assert.equal(requests, 1);
});
test('Core health rejects an oversized response and respects cancellation', async t => {
  const oversized = await server(t, (_request, response) => response.end('x'.repeat(4097)));
  await assert.rejects(requestHealth(`http://127.0.0.1:${oversized}/`, { signal: AbortSignal.timeout(1000) }), /release_health_response_invalid/);
  const hung = await server(t, () => {});
  await assert.rejects(requestHealth(`http://127.0.0.1:${hung}/`, { signal: AbortSignal.timeout(25) }), { name: 'AbortError' });
});
