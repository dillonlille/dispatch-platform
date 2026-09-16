import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture } from './rust-support.js';

// The real Rust driver talks to realistic staged HTML through the sandbox proxy.
test(
  'Cortex BrowserOS handles staged login, OTP, persistent sessions, CAPTCHA continuation and rejection',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 240000 },
  async (t) => {
    let primary = 0;
    let mode = 'otp';
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture.test');
      const html = (body: string) => {
        res.setHeader('content-type', 'text/html');
        res.end(`<html><head><title>Cortex fixture</title></head><body>${body}</body></html>`);
      };
      const redirect = (path: string) => {
        res.writeHead(302, { location: path });
        res.end();
      };
      const cookie = (value: string) =>
        res.setHeader('set-cookie', `${value}; Path=/; Max-Age=3600`);
      if (url.pathname === '/operations/execution') {
        if (mode === 'blank') return html('<h1>Loading…</h1>');
        if (req.headers.cookie?.includes('authenticated=yes') && mode !== 'reject')
          return html(
            '<h1>Delivery Execution</h1><nav>Routes · Drivers</nav><a href="/logout">Sign out</a>',
          );
        return redirect('/ap/signin');
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const fields = new URLSearchParams(body);
      if (url.pathname === '/ap/signin') {
        const challenge =
          mode === 'captcha' && !req.headers.cookie?.includes('solved=yes')
            ? `<p id="captcha">Robot check</p><button style="position:absolute;left:100px;top:100px;width:100px;height:50px" onclick="document.querySelector('#captcha').remove();document.cookie='solved=yes; Path=/';this.remove()">Solve</button>`
            : '';
        return html(
          `${challenge}<form action="/ap/password" method="post"><input id="ap_email" name="email"><button type="submit" id="continue">Continue</button></form>`,
        );
      }
      if (url.pathname === '/ap/password') {
        assert.equal(fields.get('email'), 'fixture-user');
        return html(
          '<form action="/ap/submit" method="post"><input id="ap_password" type="password" name="password"><button type="submit" id="signInSubmit">Sign in</button></form>',
        );
      }
      if (url.pathname === '/ap/submit') {
        primary++;
        assert.equal(fields.get('password'), 'fixture-password');
        if (mode === 'reject') return html('<div>Your password is incorrect</div>');
        if (mode === 'otp') return redirect('/ap/mfa');
        cookie('authenticated=yes');
        return redirect('/operations/execution');
      }
      if (url.pathname === '/ap/mfa') {
        if (fields.get('otpCode') === '123456') {
          cookie('authenticated=yes');
          return redirect('/operations/execution');
        }
        return html(
          '<p>Two-step verification</p><form action="/ap/mfa" method="post"><input id="auth-mfa-otpcode" name="otpCode"><button type="submit">Verify</button></form>',
        );
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const f = await fixture({
      env: {
        DISPATCH_FIXTURE_PROVIDER_URL: `http://fixture.dispatch.invalid:${(server.address() as AddressInfo).port}`,
        DISPATCH_BWRAP_EXECUTABLE:
          process.env.DISPATCH_BWRAP_EXECUTABLE ?? '/usr/local/libexec/dispatch-dev/bwrap',
      },
    });
    t.after(f.close);
    let owner = await f.client();
    const dsp = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
    await owner.select(dsp.id);
    const credentials = { username: 'fixture-user', password: 'fixture-password' };
    let saved = await owner.post('/api/dsp/connections/cortex', credentials);
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.value.status, 'needs_verification', saved.body);
    assert.equal(primary, 1);
    const sessionId = saved.value.verificationSessionId;
    assert.equal(
      (await owner.get(`/api/dsp/connections/cortex/screenshot?sessionId=${sessionId}`)).status,
      200,
    );
    assert.equal(
      (await owner.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).status,
      409,
    );
    assert.equal(
      (await owner.post('/api/dsp/connections/cortex/verify', { code: '654321' })).value.status,
      'needs_verification',
    );
    assert.equal(
      (await owner.post('/api/dsp/connections/cortex/verify', { code: '123456' })).value.status,
      'ready',
    );
    assert.equal(primary, 1);
    await f.stop();
    await f.start();
    owner = await f.client();
    await owner.select(dsp.id);
    let checked = await owner.post('/api/dsp/connections/cortex/check');
    assert.equal(checked.value.status, 'ready', checked.body);
    assert.equal(primary, 1);
    mode = 'captcha';
    saved = await owner.post('/api/dsp/connections/cortex', credentials);
    assert.equal(saved.value.status, 'needs_verification', saved.body);
    assert.equal(primary, 1);
    const next = saved.value.verificationSessionId;
    assert.equal(
      (await owner.post('/api/dsp/connections/cortex/submit', { sessionId: next })).value.error,
      'verification_incomplete',
    );
    await owner.post('/api/dsp/connections/cortex/assist', {
      sessionId: next,
      input: { kind: 'click', x: 150, y: 125 },
    });
    checked = await owner.post('/api/dsp/connections/cortex/submit', { sessionId: next });
    assert.equal(checked.value.status, 'ready', checked.body);
    assert.equal(primary, 2);
    mode = 'reject';
    checked = await owner.post('/api/dsp/connections/cortex/check');
    assert.equal(checked.value.error, 'invalid_credentials', checked.body);
    assert.equal(
      (await owner.post('/api/dsp/connections/cortex/check')).value.error,
      'attempt_cooldown',
    );
    assert.equal(primary, 3);
    mode = 'blank';
    saved = await owner.post('/api/dsp/connections/cortex', credentials);
    assert.equal(saved.value.status, 'needs_verification', saved.body);
    assert.equal(primary, 3);
  },
);
