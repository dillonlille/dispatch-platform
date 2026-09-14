import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Egress } from '../services/browsers/egress.js';

test('browser egress works in long private state paths and cleans up concurrent sockets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-egress-'));
  const parent = path.join(
    root,
    'nested-platform-directory-'.repeat(4),
    'data/preview/browser-runs',
  );
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const server = http.createServer((request, response) => response.end('fixture reached'));
  const proxies: Egress[] = [];
  const descriptors: number[] = [];
  t.after(async () => {
    for (const proxy of proxies) await proxy.close();
    for (const fd of descriptors) fs.closeSync(fd);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  for (const name of ['first', 'second']) {
    const run = path.join(parent, name);
    fs.mkdirSync(run, { mode: 0o700 });
    const socketPath = path.join(run, 'egress.sock');
    assert(Buffer.byteLength(socketPath) > 107);
    const proxy = new Egress(socketPath, {
      hosts: [],
      fixture: { hostname: 'fixture.dispatch.invalid', port },
    });
    proxies.push(proxy);
    await proxy.listen();
    assert(fs.statSync(socketPath).isSocket());
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(run), ['egress.sock']);
    // The sandbox sees this same file through its short /run/dispatch mount.
    const fd = fs.openSync(run, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    descriptors.push(fd);
    const response = await new Promise<string>((resolve, reject) => {
      const client = net.connect(`/proc/self/fd/${fd}/egress.sock`);
      let output = '';
      client.setTimeout(5000, () => client.destroy(new Error('Fixture request timed out')));
      client.on('error', reject);
      client.on('data', (chunk) => (output += chunk));
      client.on('end', () => resolve(output));
      client.write(
        `GET http://fixture.dispatch.invalid:${port}/ HTTP/1.1\r\nHost: fixture.dispatch.invalid\r\n\r\n`,
      );
    });
    assert.match(response, /200 OK/);
    assert.match(response, /fixture reached/);
  }
  await proxies[0]!.close();
  assert(!fs.existsSync(proxies[0]!.socketPath));
  assert(fs.existsSync(proxies[1]!.socketPath));
  await proxies[1]!.close();
  assert(!fs.existsSync(proxies[1]!.socketPath));
  for (const name of ['first', 'second'])
    assert.deepEqual(fs.readdirSync(path.join(parent, name)), []);
});

test('failed browser socket startup releases its directory handle and preserves existing files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-egress-'));
  const socketPath = path.join(root, 'egress.sock');
  const proxy = new Egress(socketPath, { hosts: [] });
  const directoryHandles = () =>
    fs.readdirSync('/proc/self/fd').filter((name) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${name}`) === root;
      } catch {
        return false;
      }
    });
  try {
    fs.writeFileSync(socketPath, 'existing file', { mode: 0o600 });
    await assert.rejects(proxy.listen(), { code: 'EADDRINUSE' });
    assert.deepEqual(directoryHandles(), []);
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'existing file');
    await proxy.close();
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'existing file');
  } finally {
    await proxy.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
