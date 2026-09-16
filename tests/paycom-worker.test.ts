import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paycomFixture, credentials } from './browseros-paycom-fixture.js';

test(
  'Rust BrowserOS authenticates exact PINs, reuses sessions, enforces cooldowns and explicit manual continuation',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 240000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    const client = await f.client();
    const dsp = client.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await client.select(dsp.id);
    const count = (event: string) => f.events.filter((e) => e === event).length;
    let saved = await client.post('/api/dsp/connections/paycom', credentials);
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.value.status, 'ready', saved.body);
    assert.equal(count('primary'), 1);
    assert.equal(count('pins'), 1);
    const check = await client.post('/api/dsp/connections/paycom/check', {});
    assert.equal(check.value.status, 'ready', check.body);
    assert.equal(count('primary'), 1);
    f.state.rejection = true;
    const rejected = await client.post('/api/dsp/connections/paycom/check', {});
    assert.equal(rejected.value.error, 'primary_credentials_rejected', rejected.body);
    const blocked = await client.post('/api/dsp/connections/paycom/check', {});
    assert.equal(blocked.value.error, 'attempt_cooldown', blocked.body);
    assert.equal(count('primary'), 2);
    assert.equal((await client.get('/api/platform/health')).value.browsers.active, 0);
    await f.stop();
    await f.start();
    const owner = await f.client();
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom/check', {})).value.error,
      'attempt_cooldown',
    );
    const diagnostic = fs.readFileSync(
      path.join(f.root, 'dsps', dsp.id, 'state/browsers/paycom-diagnostics.json'),
      'utf8',
    );
    for (const secret of [credentials.password, ...credentials.securityAnswers])
      assert(!diagnostic.includes(secret));
    f.state.rejection = false;
    f.state.mode = 'profile';
    const campaign = await owner.post('/api/dsp/connections/paycom', credentials);
    assert.equal(campaign.value.status, 'ready', campaign.body);

    for (const mode of ['before-login', 'after-pins']) {
      f.state.mode = mode;
      saved = await owner.post('/api/dsp/connections/paycom', credentials);
      assert.equal(saved.status, 200, saved.body);
      assert.equal(saved.value.status, 'needs_verification', saved.body);
      const sessionId = saved.value.verificationSessionId;
      const before = count('primary');
      const incomplete = await owner.post('/api/dsp/connections/paycom/submit', { sessionId });
      assert.equal(incomplete.value.error, 'verification_incomplete', incomplete.body);
      assert.equal(count('primary'), before);
      const shot = await owner.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`);
      assert.equal(shot.status, 200, shot.body);
      assert.equal(Buffer.from(shot.value.image, 'base64').subarray(1, 4).toString(), 'PNG');
      const wrong = await owner.get(
        '/api/dsp/connections/paycom/screenshot?sessionId=run_00000000000000000000000000000000',
      );
      assert.equal(wrong.status, 409);
      const member = await f.client('member@dispatch.test');
      await member.select(dsp.id);
      assert.equal(
        (await member.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).status,
        403,
      );
      const click = await owner.post('/api/dsp/connections/paycom/assist', {
        sessionId,
        input: { kind: 'click', x: 550, y: 370 },
      });
      assert.equal(click.status, 200, click.body);
      assert.equal(count('primary'), before);
      const completed = await owner.post('/api/dsp/connections/paycom/submit', { sessionId });
      assert.equal(completed.status, 200, completed.body);
      assert.equal(completed.value.status, 'ready', completed.body);
      const again = await owner.post('/api/dsp/connections/paycom/submit', { sessionId });
      assert.equal(again.value.status, 'ready', again.body);
      assert.equal(count('primary'), before + (mode === 'before-login' ? 1 : 0));
      assert.equal(
        (
          await owner.post('/api/dsp/connections/paycom/assist', {
            sessionId,
            input: { kind: 'click', x: 1, y: 1 },
          })
        ).status,
        409,
      );
    }
    for (const mode of ['changed-document', 'changed-pins']) {
      f.state.mode = mode;
      const challenged = await owner.post('/api/dsp/connections/paycom', credentials);
      assert.equal(challenged.value.status, 'needs_verification', challenged.body);
      const sessionId = challenged.value.verificationSessionId,
        before = count('pins');
      assert.equal(
        (
          await owner.post('/api/dsp/connections/paycom/assist', {
            sessionId,
            input: { kind: 'click', x: 550, y: 370 },
          })
        ).status,
        200,
      );
      for (let i = 0; i < 2; i++) {
        const submit = await owner.post('/api/dsp/connections/paycom/submit', { sessionId });
        assert.equal(submit.value.error, 'verification_incomplete', submit.body);
        assert.equal(
          count('pins'),
          before,
          'Changed document or PINs must never be adopted for replay',
        );
      }
    }
    f.state.mode = '';
    const badPins = await owner.post('/api/dsp/connections/paycom', {
      ...credentials,
      securityAnswers: ['One', 'Two', 'Wrong PIN', 'Four', ' Five? '],
    });
    assert.equal(badPins.value.error, 'security_answers_rejected', badPins.body);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom/check', {})).value.error,
      'attempt_cooldown',
    );
  },
);
