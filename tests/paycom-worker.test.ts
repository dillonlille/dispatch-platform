import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixture, until } from './helpers.js';
import { configuration } from '../services/config.js';

test(
  'archived auth runs through save/check API and the real isolated worker, preserving PINs and rejection cooldowns',
  {
    skip: process.env.DISPATCH_TEST_NATIVE !== '1',
    timeout: 120_000,
  },
  async (t) => {
    fs.mkdirSync('.runtime', { mode: 0o700, recursive: true });
    const root = fs.mkdtempSync(path.resolve('.runtime/paycom-worker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundle = path.join(root, 'services/runtime');
    fs.cpSync('.build/services/runtime', bundle, { recursive: true });
    fs.symlinkSync(path.resolve('.build/node_modules'), path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.renameSync(path.join(bundle, 'auth-worker.js'), path.join(bundle, 'real-worker.js'));
    fs.copyFileSync(
      'tests/archived-paycom/helpers/worker-fixture.js',
      path.join(bundle, 'fixture.cjs'),
    );
    fs.writeFileSync(
      path.join(bundle, 'auth-worker.js'),
      `import './fixture.cjs'; await import('./real-worker.js');`,
    );
    const f = await fixture({ runtimeBundle: bundle });
    Object.defineProperty(f.runtime.storage, 'config', {
      value: configuration({ ...f.runtime.storage.config, providerMode: 'native' }),
    });
    t.after(() => f.close());
    const client = await f.client();
    const dsp = client.session.dsps.find((d) => d.name === 'Northline Logistics')!;
    await client.select(dsp.id);
    const credentials = {
      clientCode: 'fixture-client',
      username: 'fixture-user',
      password: 'fixture-password',
      securityAnswers: ['One', 'Two', '00 Three !', 'Four', ' Five? '],
    };
    const saved = await client.post('/api/dsp/connections/paycom', credentials);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().status, 'ready', saved.body);
    assert.deepEqual(f.runtime.broker.vault.read(dsp.id), credentials);
    const profile = f.runtime.storage.paths.profile(dsp.id);
    const events = () =>
      fs.readFileSync(path.join(profile, 'fixture-events'), 'utf8').trim().split('\n');
    assert.equal(events().filter((value) => value === 'primary').length, 1);
    assert.equal(events().filter((value) => value === 'pins').length, 1);
    const before = events().length;
    const check = await client.post('/api/dsp/connections/paycom/check', {});
    assert.equal(check.statusCode, 200, check.body);
    assert.equal(check.json().status, 'ready');
    assert(events().length > before, 'Test connection must inspect Paycom again');
    assert.equal(
      events().filter((value) => value === 'primary').length,
      1,
      'A valid session must not resubmit credentials',
    );
    // A subsequent provider rejection must replace Ready, close the worker, and
    // keep the durable cooldown when an owner immediately requests another check.
    fs.writeFileSync(path.join(profile, 'force-rejection'), '', { mode: 0o600 });
    const rejected = await client.post('/api/dsp/connections/paycom/check', {});
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error, 'primary_credentials_rejected');
    assert.equal(f.runtime.broker.connection(dsp.id).status, 'error');
    assert.equal(f.runtime.browsers.sessions.has(dsp.id), false);
    const blocked = await client.post('/api/dsp/connections/paycom/check', {});
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json().error, 'attempt_cooldown');
    assert.equal(
      events().filter((value) => value === 'primary').length,
      2,
      'Cooldown must stop a repeated submission',
    );
    const diagnostics = fs.readFileSync(
      path.join(profile, 'authentication/diagnostics.json'),
      'utf8',
    );
    for (const secret of [credentials.password, ...credentials.securityAnswers])
      assert(!diagnostics.includes(secret));
    // The archived host relay and continuation are exercised with a deterministic
    // local solver. This never calls Hermes or a model provider.
    const require = createRequire(import.meta.url);
    const { browserRelay } = require('../services/browsers/assistance/vendor/relay.js');
    const { CdpConnection } = require('../integrations/paycom/provider/auth/cdp.js');
    let assistanceCalls = 0;
    Object.defineProperty(f.runtime.browsers.assistance, 'enabled', { get: () => true });
    t.mock.method(
      f.runtime.browsers.assistance,
      'solve',
      async (_dspId: string, run: string, browserPath: string, signal: AbortSignal) => {
        assistanceCalls++;
        const relay = await browserRelay(path.join(run, 'cdp.sock'), browserPath);
        let control: any;
        try {
          control = await CdpConnection.connect(relay.endpoint, { signal });
          const { targetInfos } = await control.command('Target.getTargets');
          const target = targetInfos.find(
            (target: { type: string; url: string }) =>
              target.type === 'page' && target.url.includes('/cl-login.php'),
          );
          assert(target, 'Solver must receive the original login challenge');
          const { sessionId } = await control.command('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          });
          // The flat target command is sent directly through the bounded CDP transport.
          await new Promise<void>((resolve, reject) => {
            const id = 9000;
            const listener = (event: MessageEvent) => {
              const reply = JSON.parse(String(event.data));
              if (reply.id !== id) return;
              control.socket.removeEventListener('message', listener);
              reply.error ? reject(new Error('Fixture solver failed')) : resolve();
            };
            control.socket.addEventListener('message', listener);
            control.socket.send(
              JSON.stringify({
                id,
                sessionId,
                method: 'Runtime.evaluate',
                params: { expression: 'document.getElementById("solveCaptcha").click()' },
              }),
            );
          });
        } finally {
          control?.close();
          await relay.close();
        }
      },
    );
    fs.writeFileSync(path.join(bundle, 'captcha-mode'), 'enabled');
    const challenged = await client.post('/api/dsp/connections/paycom', credentials);
    assert.equal(challenged.statusCode, 200, challenged.body);
    assert.equal(challenged.json().status, 'needs_verification');
    await until(() => f.runtime.broker.connection(dsp.id).status === 'ready', 20_000);
    assert.equal(assistanceCalls, 1);
    assert.equal(events().filter((value) => value === 'primary').length, 1);
    assert.equal(events().filter((value) => value === 'pins').length, 1);
  },
);
