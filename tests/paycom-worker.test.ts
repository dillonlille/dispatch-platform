import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './rust-support.js';
import { createDecipheriv } from 'node:crypto';

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
    const f = await fixture({
      env: { DISPATCH_RUNTIME_BUNDLE: bundle, DISPATCH_PROVIDER_MODE: 'native' },
    });
    t.after(() => f.close());
    const client = await f.client();
    const dsp = client.session.dsps.find(
      (d: { name: string; id: string }) => d.name === 'Northline Logistics',
    )!;
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
    const secrets = path.join(f.root, 'dsps', dsp.id, 'secrets');
    const [nonce, encrypted] = fs.readFileSync(path.join(secrets, 'paycom.enc'), 'utf8').split('.');
    const bytes = Buffer.from(encrypted!, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      fs.readFileSync(path.join(secrets, 'vault.key')),
      Buffer.from(nonce!, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`${dsp.id}:paycom:2`));
    decipher.setAuthTag(bytes.subarray(-16));
    assert.deepEqual(
      JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(),
      ),
      credentials,
    );
    const profile = path.join(f.root, 'dsps', dsp.id, 'state/browsers/paycom');
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
    assert.equal((await client.get('/api/dsp/connections')).value.status, 'error');
    assert.equal((await client.get('/api/platform/health')).value.browsers.active, 0);
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
    // A human controls the same browser through the authenticated API. Solving
    // the local challenge alone must not resume login until Submit is pressed.
    for (const phase of ['before-login', 'after-pins']) {
      fs.writeFileSync(path.join(bundle, 'captcha-mode'), phase);
      const challenged = await client.post('/api/dsp/connections/paycom', credentials);
      assert.equal(challenged.statusCode, 200, challenged.body);
      assert.equal(challenged.json().status, 'needs_verification');
      const sessionId = challenged.json().verificationSessionId;
      assert.match(sessionId, /^run_[a-f0-9]{32}$/);
      const beforeInput = events().filter((value) => value === 'primary').length;
      const premature = await client.post('/api/dsp/connections/paycom/submit', { sessionId });
      assert.equal(premature.statusCode, 409, premature.body);
      assert.equal(premature.json().error, 'verification_incomplete');
      assert.equal(events().filter((value) => value === 'primary').length, beforeInput);
      assert.equal(events().filter((value) => value === 'pins').length, 0);
      const frame = await client.get(
        `/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`,
      );
      assert.equal(frame.statusCode, 200, frame.body.slice(0, 200));
      assert.equal(frame.json().sessionId, sessionId);
      assert(frame.json().image.length > 1000);
      const wrongSession = await client.post('/api/dsp/connections/paycom/assist', {
        sessionId: 'run_' + '0'.repeat(32),
        input: { kind: 'click', x: 960, y: 470 },
      });
      assert.equal(wrongSession.statusCode, 409);
      // Frame polling and ordered inputs share one worker without crossing replies.
      const inputs = [
        { kind: 'pointer', phase: 'down', pressed: true, x: 960, y: 470 },
        { kind: 'pointer', phase: 'move', pressed: true, x: 965, y: 471 },
        { kind: 'pointer', phase: 'up', pressed: false, x: 965, y: 471 },
      ];
      const responses = await Promise.all([
        ...inputs.map((input) =>
          client.post('/api/dsp/connections/paycom/assist', { sessionId, input }),
        ),
        client.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`),
      ]);
      for (const response of responses)
        assert.equal(response.statusCode, 200, response.body.slice(0, 200));
      assert.equal((await client.get('/api/dsp/connections')).value.status, 'needs_verification');
      assert.equal(events().filter((value) => value === 'primary').length, beforeInput);
      assert.equal(
        events().filter((value) => value === 'pins').length,
        0,
        'Inputs must not submit retained PINs',
      );
      const completed = await client.post('/api/dsp/connections/paycom/submit', { sessionId });
      assert.equal(completed.statusCode, 200, completed.body);
      assert.equal(completed.json().status, 'ready');
      assert.equal(events().filter((value) => value === 'primary').length, 1);
      assert.equal(events().filter((value) => value === 'pins').length, 1);
      assert.equal(
        (await client.post('/api/dsp/connections/paycom/submit', { sessionId })).statusCode,
        200,
        'Submit is idempotent after success',
      );
      assert.equal(
        (await client.post('/api/dsp/connections/paycom/assist', { sessionId, input: inputs[0] }))
          .statusCode,
        409,
        'Completed windows cannot send more input',
      );
    }
  },
);
