import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';
import { fixture, until } from './rust-support.js';
import { fixtureWorkforce } from './paycom-fixture.js';

test(
  'Rust browser broker verifies and collects in long state paths with separate DSP profiles',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 120000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rust-browser-'));
    const stateRoot = path.join(root, 'nested-platform-directory-'.repeat(4), 'dev');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let authenticatedRequests = 0,
      loginRequests = 0;
    const workforce = fixtureWorkforce({
      id: 'fixture',
      name: 'Fixture',
      environment: 'preview',
      status: 'active',
      timezone: 'UTC',
      permanent: false,
      revision: 1,
      createdAt: new Date().toISOString(),
    });
    const server = http.createServer((req, res) => {
      const logged = req.headers.cookie?.includes('fixture_session=one');
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/login' && logged)
        return res.end('<main data-authenticated="true">Connected</main>');
      if (req.url === '/login') {
        loginRequests++;
        return res.end(
          '<form method="post" action="/challenge"><input name="clientcode"><input name="username"><input name="password" type="password"><button>Sign in</button></form>',
        );
      }
      if (req.url === '/challenge')
        return res.end(
          '<form method="post" action="/verified"><input name="code" autocomplete="one-time-code"><button>Verify</button></form>',
        );
      if (req.url === '/verified') {
        res.setHeader('Set-Cookie', 'fixture_session=one; Path=/; Max-Age=3600; HttpOnly');
        return res.end('<main data-authenticated="true">Connected</main>');
      }
      if (req.url === '/workforce' && logged) {
        authenticatedRequests++;
        return res.end(`<pre>${JSON.stringify(workforce)}</pre>`);
      }
      res.writeHead(403);
      res.end('Not authenticated');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const url = `http://fixture.dispatch.invalid:${(server.address() as net.AddressInfo).port}`;
    const f = await fixture({
      env: {
        DISPATCH_STATE_ROOT: stateRoot,
        DISPATCH_RUNTIME_BUNDLE: path.resolve('.build/services/runtime'),
        DISPATCH_FIXTURE_PROVIDER_URL: url,
        DISPATCH_BROWSER_EXECUTABLE: chromium.executablePath(),
      },
    });
    t.after(f.close);
    const owner = await f.client();
    const north = owner.session.dsps.find(
      (d: { name: string }) => d.name === 'Northline Logistics',
    );
    const summit = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
    await owner.select(north.id);
    const credentials = {
      clientCode: 'test',
      username: 'test',
      password: 'test',
      securityAnswers: ['one', 'two', 'three', 'four', 'five'],
    };
    const saved = await owner.post('/api/dsp/connections/paycom', credentials);
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.value.status, 'needs_verification');
    const sessionId = saved.value.verificationSessionId;
    assert.match(sessionId, /^run_[a-f0-9]{32}$/);
    const frame = await owner.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`);
    assert.equal(frame.status, 200, frame.body);
    assert(frame.value.image.length > 1000);
    const member = await f.client('member@dispatch.test');
    await member.select(north.id);
    assert.equal(
      (await member.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          '/api/dsp/connections/paycom/assist',
          { sessionId, input: { kind: 'click', x: 10, y: 10 } },
          { ...owner.headers, 'x-csrf-token': 'wrong' },
        )
      ).status,
      403,
    );
    await owner.select(summit.id);
    assert.equal(
      (await owner.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).status,
      409,
    );
    await owner.select(north.id);
    assert.equal(
      (
        await owner.post('/api/dsp/connections/paycom/assist', {
          sessionId,
          input: { kind: 'click', x: 1e9, y: 10 },
        })
      ).status,
      400,
    );
    const verified = await owner.post('/api/dsp/connections/paycom/verify', { code: '123456' });
    assert.equal(verified.status, 200, verified.body);
    assert.equal(verified.value.status, 'ready');
    const job = await owner.post('/api/dsp/jobs', { requestId: 'native-collection' });
    assert.equal(job.status, 202);
    await until(async () => {
      const value = (await owner.get('/api/dsp/jobs')).value[0];
      assert.notEqual(value.status, 'failed', JSON.stringify(value));
      return value.status === 'succeeded';
    }, 45000);
    assert.equal(authenticatedRequests, 1);
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 12);
    await until(async () => (await owner.get('/api/platform/health')).value.browsers.active === 0);
    await owner.select(summit.id);
    const second = await owner.post('/api/dsp/connections/paycom', credentials);
    assert.equal(second.value.status, 'needs_verification', second.body);
    assert.equal(loginRequests, 2);
    const profile = (id: string) => path.join(stateRoot, 'dsps', id, 'state/browsers/paycom');
    assert.notEqual(fs.statSync(profile(north.id)).ino, fs.statSync(profile(summit.id)).ino);
    assert.equal(fs.statSync(profile(north.id)).mode & 0o077, 0);
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
  },
);
