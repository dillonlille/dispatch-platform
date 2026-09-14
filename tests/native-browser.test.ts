import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { fixture } from './helpers.js';
import { fixtureWorkforce } from '../integrations/paycom/fixture.js';
import { Egress, publicAddress } from '../services/browsers/egress.js';

test('egress refuses loopback, private addresses and unapproved destinations', async (t) => {
  for (const address of [
    '127.0.0.1',
    '10.1.1.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.1.1',
    '::ffff:127.0.0.1',
    '::1',
  ])
    assert.equal(publicAddress(address), false);
  const f = await fixture();
  t.after(() => f.close());
  const proxy = new Egress(path.join(f.root, 'egress.sock'), { hosts: [] });
  await proxy.listen();
  t.after(() => proxy.close());
  const response = await new Promise<string>((resolve) => {
    const socket = net.connect(proxy.socketPath);
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.once('close', () => resolve(data));
    socket.on('error', () => {});
    socket.write('CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  });
  assert.equal(response, '');
});

test(
  'native Chromium in a private namespace logs in, verifies, collects and preserves only its DSP profile',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 120000 },
  async (t) => {
    assert(
      fs.existsSync('.build/services/runtime/auth-worker.js'),
      'Build before native verification',
    );
    const f = await fixture({ runtimeBundle: path.resolve('.build/services/runtime') });
    t.after(() => f.close());
    const client = await f.client(),
      dsp = client.session.dsps.find((d) => d.name === 'Northline Logistics')!;
    let authenticatedRequests = 0;
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const logged = req.headers.cookie?.includes('fixture_session=one');
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/login' && logged) {
        res.end('<main data-authenticated="true">Connected</main>');
        return;
      }
      if (req.url === '/login') {
        res.end(
          '<form method="post" action="/challenge"><input name="clientcode"><input name="username"><input name="password" type="password"><button>Sign in</button></form>',
        );
        return;
      }
      if (req.url === '/challenge') {
        res.end(
          '<form method="post" action="/verified"><input name="code" autocomplete="one-time-code"><button>Verify</button></form>',
        );
        return;
      }
      if (req.url === '/verified') {
        res.setHeader('Set-Cookie', 'fixture_session=one; Path=/; Max-Age=3600; HttpOnly');
        res.end('<main data-authenticated="true">Connected</main>');
        return;
      }
      if (req.url === '/workforce' && logged) {
        authenticatedRequests++;
        res.end(`<pre>${JSON.stringify(fixtureWorkforce(dsp))}</pre>`);
        return;
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
    let diagnostics = '';
    const acquiring = f.runtime.browsers.acquire(
      dsp,
      { clientCode: 'test', username: 'test', password: 'test' },
      url,
    );
    f.runtime.browsers.sessions
      .get(dsp.id)
      ?.on('diagnostic', (text) => (diagnostics += String(text)));
    let session;
    try {
      session = await acquiring;
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${diagnostics}`);
    }
    assert.equal(session.status, 'challenge');
    const screenshot = await session.screenshot();
    assert(screenshot.length > 1000);
    try {
      await session.verify('123456');
      assert.equal(session.status, 'ready');
      const data = await session.collect(() => {});
      assert.equal(data.employees.length, 12);
      assert.equal(authenticatedRequests, 1);
    } catch (error) {
      fs.writeFileSync('/tmp/dispatch-native-failure.png', Buffer.from(screenshot, 'base64'));
      throw new Error(
        `${(error as Error).message}\nRequests: ${requests.join(', ')}\n${diagnostics}`,
      );
    }
    await session.close();
    const next = await f.runtime.browsers.acquire(
      dsp,
      { clientCode: 'ignored', username: 'ignored', password: 'ignored' },
      url,
    );
    assert.equal(next.status, 'ready');
    await next.close();
    const other = client.session.dsps.find((d) => d.name === 'Summit Delivery')!;
    const separate = await f.runtime.browsers.acquire(
      other,
      { clientCode: 'test', username: 'test', password: 'test' },
      url,
    );
    assert.equal(separate.status, 'challenge');
    await separate.close();
    assert.equal(f.runtime.browsers.health().active, 0);
  },
);
