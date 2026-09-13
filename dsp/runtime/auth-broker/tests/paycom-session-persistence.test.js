'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChromeBrowserRuntime, processGroupAlive } = require('../src/browser-runtime');
const { CdpConnection, createTarget } = require('../src/cdp');

const chrome = process.env.DISPATCH_CHROME_EXECUTABLE
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));

for (const transport of ['pipe', 'tcp']) {
  test(`Paycom ${transport} sessions retain cookies after close and broker reconciliation`, {
    skip: !chrome && 'Chrome is required for the browser regression', timeout: 40_000,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-cookies-'));
    let seeded = false, seedResponses = 0, seedRequests = 0, browser, connection;
    const server = http.createServer((request, response) => {
      if (request.url === '/seed') seedRequests++;
      // Restored tabs must not recreate cookies and conceal lost profile state.
      if (request.url === '/seed' && !seeded) {
        seeded = true;
        seedResponses++;
        response.setHeader('Set-Cookie', [
          'fixture_session=retained; Path=/; HttpOnly',
          'fixture_persistent=retained; Path=/; HttpOnly; Max-Age=3600',
        ]);
      }
      response.end('<!doctype html><title>Local session fixture</title>');
    });
    const options = { stateRoot: path.join(root, 'profiles'), socketRoot: path.join(root, 'run'), executable: chrome, transport };
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const cookies = async () => (await connection.command('Network.getCookies', { urls: [origin] })).cookies
        .map(cookie => ({ name: cookie.name, value: cookie.value, session: cookie.session }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const expected = [
        { name: 'fixture_persistent', value: 'retained', session: false },
        { name: 'fixture_session', value: 'retained', session: true },
      ];
      browser = await new ChromeBrowserRuntime(options).launch({ provider: 'paycom', profile: 'fixture' });
      let target = await createTarget(browser.endpoint, `${origin}/seed`);
      connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
      for (let i = 0; i < 100 && (await cookies()).length !== 2; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(await cookies(), expected);
      connection.close(); connection = null;
      await browser.close(); browser = null;

      const restartedRuntime = new ChromeBrowserRuntime(options);
      await restartedRuntime.reconcile();
      browser = await restartedRuntime.launch({ provider: 'paycom', profile: 'fixture' });
      target = await createTarget(browser.endpoint, 'about:blank');
      connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
      assert.deepEqual(await cookies(), expected);
      assert.equal(seedResponses, 1);
      const browserConnection = await CdpConnection.connect(browser.browserWebSocketUrl);
      try {
        const targets = await browserConnection.command('Target.getTargets');
        assert.equal(targets.targetInfos.some(target => target.type === 'page' && target.url.startsWith(origin)), false);
      } finally { browserConnection.close(); }
      assert.equal(seedRequests, 1);
    } finally {
      connection?.close();
      await browser?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('persistent Paycom shutdown still terminates a stalled Chrome process group', {
  skip: !chrome && 'Chrome is required for the browser regression', timeout: 25_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-stalled-'));
  let browser;
  try {
    browser = await new ChromeBrowserRuntime({ stateRoot: path.join(root, 'profiles'), socketRoot: path.join(root, 'run'),
      executable: chrome, transport: 'pipe' }).launch({ provider: 'paycom', profile: 'fixture' });
    process.kill(-browser.pid, 'SIGSTOP');
    await browser.close();
    assert.equal(processGroupAlive(browser.pid), false);
    await browser.close(); // Cleanup remains idempotent after the forced fallback.
  } finally {
    if (browser && processGroupAlive(browser.pid)) {
      try { process.kill(-browser.pid, 'SIGCONT'); } catch {}
      await browser.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
