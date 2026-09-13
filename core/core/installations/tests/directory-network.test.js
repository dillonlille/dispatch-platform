'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { networkPolicy, publicAddress, loadNetworkPolicy } = require('../../../host/networking/network-policy');
const { DirectoryEgress } = require('../../../host/networking/egress');
const { createEgressRelay } = require('dispatch-dsp/runtime/supervisor/src/egress-relay.js');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-'));
  fs.mkdirSync(path.join(root, '.control'), { mode: 0o700 });
  const events = [], addresses = [], clients = [];
  const origin = net.createServer(socket => { clients.push(socket); socket.pipe(socket); });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const egress = new DirectoryEgress({ dspRoot: root, policy: networkPolicy({ version: 1, hosts: ['provider.example'] }),
    resolve: async () => ['93.184.216.34'], onEvent: event => events.push(event),
    connect: input => { addresses.push(input); return net.createConnection({ host: '127.0.0.1', port: origin.address().port }); }, ...options });
  await egress.start();
  const relay = createEgressRelay({ socketPath: path.join(root, '.control/egress.sock'), port: 0 });
  await relay.start();
  t.after(async () => {
    await relay.close(); await egress.close();
    for (const client of clients) client.destroy();
    await new Promise(resolve => origin.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, egress, relay, events, addresses,
    async request(raw) {
      const socket = net.createConnection({ host: '127.0.0.1', port: relay.server.address().port });
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(raw);
      return socket;
    },
  };
}

test('policy admits exact provider names and bounded subdomains, with all special addresses excluded', () => {
  const policy = networkPolicy({ version: 1, hosts: ['provider.example', '*.assets.example'] });
  for (const host of ['provider.example', 'img.assets.example']) assert.equal(policy.allows(host), true);
  for (const host of ['provider.example.evil.test', 'evilprovider.example', 'assets.example', '127.0.0.1', '[::1]',
    'provider.example.', 'provider.example:443', 'PROVIDER.EXAMPLE']) assert.equal(policy.allows(host), false);
  for (const ip of ['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.0.1', '192.168.1.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', '2130706433']) {
    assert.equal(publicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1']) assert.equal(publicAddress(ip), true, ip);
  for (const hosts of [['*'], ['*.com'], ['127.0.0.1'], ['provider.example/path'], ['provider.example', 'provider.example']]) {
    assert.throws(() => networkPolicy({ version: 1, hosts }));
  }
});

test('real Unix relay tunnels only to a pinned approved address and keeps application bytes private', async t => {
  const f = await fixture(t);
  const socket = await f.request('CONNECT provider.example:443 HTTP/1.1\r\nHost: provider.example:443\r\n\r\n');
  assert.match(String((await once(socket, 'data'))[0]), /^HTTP\/1.1 200/);
  socket.write('synthetic private bytes');
  assert.equal(String((await once(socket, 'data'))[0]), 'synthetic private bytes');
  assert.deepEqual(f.addresses, [{ host: '93.184.216.34', port: 443, family: 4 }]);
  assert.deepEqual(f.events, [{ status: 'connected', host: 'provider.example' }]);
  socket.destroy();
});

test('IP literals, HTTP forwarding, alternate ports and unapproved names fail before DNS or connection', async t => {
  let resolutions = 0;
  const f = await fixture(t, { resolve: async () => { resolutions++; return ['8.8.8.8']; } });
  for (const target of ['127.0.0.1:443', '[::1]:443', '2130706433:443', 'provider.example:80',
    'provider.example.evil.test:443', 'user@provider.example:443']) {
    const socket = await f.request(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    assert.match(String((await once(socket, 'data'))[0]), /^HTTP\/1.1 403/); socket.destroy();
  }
  const socket = await f.request('GET http://provider.example/ HTTP/1.1\r\nHost: provider.example\r\n\r\n');
  assert.match(String((await once(socket, 'data'))[0]), /^HTTP\/1.1 405/); socket.destroy();
  assert.equal(resolutions, 0); assert.deepEqual(f.addresses, []);
});

test('DNS rebinding, mixed public/private answers and revocation during resolution cannot reach a host socket', async t => {
  let answer = ['127.0.0.1'], permitted = true;
  const f = await fixture(t, { permitted: () => permitted, resolve: async () => answer });
  for (const values of [['127.0.0.1'], ['8.8.8.8', '169.254.169.254'], ['::1'], []]) {
    answer = values;
    const socket = await f.request('CONNECT provider.example:443 HTTP/1.1\r\n\r\n');
    assert.match(String((await once(socket, 'data'))[0]), /^HTTP\/1.1 403/); socket.destroy();
  }
  f.egress.resolve = async () => { permitted = false; return ['8.8.8.8']; };
  const socket = await f.request('CONNECT provider.example:443 HTTP/1.1\r\n\r\n');
  await once(socket, 'close'); assert.deepEqual(f.addresses, []);
});

test('revoking a running DSP closes existing tunnels', async t => {
  let permitted = true;
  const f = await fixture(t, { permitted: () => permitted });
  const socket = await f.request('CONNECT provider.example:443 HTTP/1.1\r\n\r\n');
  await once(socket, 'data');
  permitted = false;
  await once(socket, 'close');
  assert.equal(f.egress.sockets.size, 0);
});

test('private policy loads outside source and refuses permissive file modes or links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { mode: 0o700 });
  const paths = { local: root }, file = path.join(root, 'config/directory-network.json');
  assert.equal(loadNetworkPolicy(paths).allows('www.amazon.com'), true);
  fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [] }), { mode: 0o600 });
  assert.equal(loadNetworkPolicy(paths).allows('www.amazon.com'), false);
  fs.chmodSync(file, 0o644); assert.throws(() => loadNetworkPolicy(paths));
});
