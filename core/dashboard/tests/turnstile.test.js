'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTurnstile, turnstileFromEnvironment, SITEVERIFY_URL } = require('../server/turnstile');
const siteKey = '0x' + 'a'.repeat(24), secret = '0x' + 'b'.repeat(33);
const hostname = 'dispatch.example.test';
const options = { siteKey, secret, hostname };
const result = (value) => ({ ok: true, json: async () => value });

test('Siteverify sends only verification data and checks exact hostname and action', async () => {
  let request;
  const verifier = createTurnstile({ ...options, fetchImpl: async (url, init) => {
    request = { url, init };
    return result({ success: true, hostname, action: 'login' });
  } });
  await verifier.verify('browser-token', 'login', '192.0.2.1');
  assert.equal(request.url, SITEVERIFY_URL);
  assert.equal(request.init.redirect, 'error');
  assert.deepEqual(JSON.parse(request.init.body), { secret, response: 'browser-token', remoteip: '192.0.2.1' });
  assert.deepEqual(verifier.publicConfig, { siteKey });
  assert.ok(!JSON.stringify(verifier).includes(secret));
  for (const value of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, hostname: 'attacker.example', action: 'login' },
    { success: true, hostname, action: 'register' },
    { success: true, hostname }, { success: true, action: 'login' },
  ]) {
    const denied = createTurnstile({ ...options, fetchImpl: async () => result(value) });
    await assert.rejects(denied.verify('browser-token', 'login'), { code: 'turnstile_invalid', statusCode: 403 });
  }
});

test('missing and oversized tokens never contact Cloudflare; outages fail closed without leaking details', async () => {
  let calls = 0;
  const verifier = createTurnstile({ ...options, fetchImpl: async () => { calls++; throw Error(secret); } });
  for (const token of [undefined, null, '', {}, 123, 'a'.repeat(2049), 'two tokens']) {
    await assert.rejects(verifier.verify(token, 'login'), { code: 'turnstile_required', statusCode: 400 });
  }
  assert.equal(calls, 0);
  for (const fetchImpl of [
    async () => { throw Error(secret); },
    async () => ({ ok: false, status: 502 }),
    async () => ({ ok: true, json: async () => { throw Error(secret); } }),
    async () => result({ success: 'true' }),
    async (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
  ]) {
    const denied = createTurnstile({ ...options, fetchImpl, timeoutMs: 5 });
    await assert.rejects(denied.verify('browser-token', 'login'), {
      code: 'turnstile_unavailable', statusCode: 503, message: 'turnstile_unavailable',
    });
  }
});

test('activation requires a private secret and canonical origin and rejects Cloudflare dummy keys', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-turnstile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'turnstile'), file = path.join(directory, 'secret-key');
  fs.mkdirSync(directory, { mode: 0o700 });
  const config = { paths: { secretsRoot: root }, publicOrigin: `https://${hostname}`, environment: { DISPATCH_TURNSTILE_SITE_KEY: siteKey } };
  assert.equal(turnstileFromEnvironment({ environment: {} }), null);
  assert.throws(() => turnstileFromEnvironment(config), /turnstile_config_invalid/);
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  assert.deepEqual(turnstileFromEnvironment(config).publicConfig, { siteKey });
  for (const publicOrigin of [null, 'http://127.0.0.1', 'https://attacker.example/path']) {
    assert.throws(() => turnstileFromEnvironment({ ...config, publicOrigin }), /turnstile_config_invalid/);
  }
  for (const key of ['', 'bad key', '1x00000000000000000000AA']) {
    assert.throws(() => turnstileFromEnvironment({ ...config, environment: { DISPATCH_TURNSTILE_SITE_KEY: key } }), /turnstile_config_invalid/);
  }
  fs.chmodSync(file, 0o644);
  assert.throws(() => turnstileFromEnvironment(config), /turnstile_config_invalid/);
  fs.chmodSync(file, 0o600); fs.chmodSync(directory, 0o755);
  assert.throws(() => turnstileFromEnvironment(config), /turnstile_config_invalid/);
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(file, '1x0000000000000000000000000000000AA');
  assert.throws(() => turnstileFromEnvironment(config), /turnstile_config_invalid/);
  fs.renameSync(file, file + '.real'); fs.symlinkSync(file + '.real', file);
  assert.throws(() => turnstileFromEnvironment(config), /turnstile_config_invalid/);
  fs.unlinkSync(file); fs.linkSync(file + '.real', file);
  assert.throws(() => turnstileFromEnvironment(config), /turnstile_config_invalid/);
});
