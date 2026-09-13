'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { createEgressRelay } = require('dispatch-dsp/runtime/supervisor/src/egress-relay.js');
const { ChromeBrowserRuntime } = require('dispatch-dsp/runtime/auth-broker/src/browser-runtime.js');
const { CdpConnection, createTarget } = require('dispatch-dsp/runtime/auth-broker/src/cdp.js');
const { configuration, assertMountBoundary } = require('dispatch-dsp/runtime/supervisor/src/supervisor.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assertMountBoundary(configuration());
  assert.deepEqual(fs.readdirSync('/sys/class/net'), ['lo']);
  const relay = createEgressRelay(); await relay.start();
  let browser, connection;
  const results = [];
  const options = { stateRoot: path.join(path.dirname(process.env.DISPATCH_DATA_ROOT), 'browser/network-verification'),
    socketRoot: process.env.DISPATCH_RUNTIME_ROOT };
  try {
    browser = await new ChromeBrowserRuntime(options).launch({ provider: 'paycom', profile: 'synthetic-network' });
    const target = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await connection.command('Network.enable');
    for (const url of ['https://www.paycomonline.net/v4/cl/web.php', 'https://logistics.amazon.com/operations/execution']) {
      const navigated = await connection.command('Page.navigate', { url });
      assert.equal(navigated.errorText, undefined, JSON.stringify(navigated));
      let view;
      for (let attempt = 0; attempt < 200; attempt++) {
        view = await connection.evaluate(`({url:location.origin,ready:document.readyState,inputs:document.querySelectorAll('input').length,secure:window.isSecureContext})`);
        if (view.ready === 'complete' && view.inputs > 0) break;
        await delay(100);
      }
      assert.ok(view.secure && view.inputs > 0, JSON.stringify(view));
      assert.match(view.url, /^https:\/\/(www\.paycomonline\.net|www\.amazon\.com|logistics\.amazon\.com)$/);
      results.push({ origin: view.url, secureContext: view.secure, loginInputs: view.inputs });
    }
    await connection.command('Network.setCookie', { name: 'dispatch_rebuild_probe', value: 'synthetic',
      url: 'https://www.paycomonline.net', secure: true, httpOnly: true });
    connection.close(); connection = null; await browser.close(); browser = null;
    browser = await new ChromeBrowserRuntime(options).launch({ provider: 'paycom', profile: 'synthetic-network' });
    const next = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(next.webSocketDebuggerUrl);
    const cookies = await connection.command('Network.getCookies', { urls: ['https://www.paycomonline.net'] });
    assert.ok(cookies.cookies.some(cookie => cookie.name === 'dispatch_rebuild_probe' && cookie.value === 'synthetic'));
    await connection.command('Network.deleteCookies', { name: 'dispatch_rebuild_probe', url: 'https://www.paycomonline.net' });
    // Direct public connections still have no route from this network namespace.
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '8.8.8.8', port: 443 });
      socket.once('connect', () => { socket.destroy(); reject(new Error('direct_network_visible')); });
      socket.once('error', () => { socket.destroy(); resolve(); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
    });
    process.stdout.write(JSON.stringify({ ok: true, providers: results, sessionRetained: true, directNetworkBlocked: true }) + '\n');
  } finally { connection?.close(); await browser?.close(); await relay.close(); }
}
main().catch(error => {
  fs.writeFileSync(path.join(process.env.DISPATCH_LOGS_ROOT, 'network-verification-error.log'), error.stack + '\n', { mode: 0o600 });
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
});
