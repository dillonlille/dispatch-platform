'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { configuration, assertMountBoundary } = require('dispatch-dsp/runtime/supervisor/src/supervisor.js');
const { ChromeBrowserRuntime } = require('dispatch-dsp/runtime/auth-broker/src/browser-runtime.js');
const { CdpConnection, createTarget } = require('dispatch-dsp/runtime/auth-broker/src/cdp.js');

async function main() {
  process.umask(0o077);
  const [hostRoot, sibling, hostPidNamespace] = process.argv.slice(2);
  const config = configuration();
  const root = path.dirname(process.env.DISPATCH_DATA_ROOT);
  assert.ok(process.pid > 1, 'namespace init must own subprocess reaping');
  try { assertMountBoundary(config); }
  catch (error) {
    fs.writeFileSync(path.join(root, 'logs/isolation-mounts.log'), fs.readFileSync('/proc/self/mountinfo'), { mode: 0o600 });
    throw error;
  }
  assert.ok(process.geteuid() > 0);
  assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), hostPidNamespace);
  for (const file of [hostRoot, `/var/lib/dispatch/${sibling}`, '/run/docker.sock', '/etc/shadow']) {
    assert.equal(fs.existsSync(file), false, 'host or sibling path visible');
  }
  for (const name of ['.service-root', '.code-view', '.control']) {
    assert.throws(() => fs.readdirSync(path.join(root, name)));
    assert.throws(() => fs.renameSync(path.join(root, name), path.join(root, name + '-moved')));
  }
  assert.throws(() => fs.writeFileSync('/opt/dispatch/.write-probe', 'forbidden'));
  assert.equal(fs.statSync(process.env.DISPATCH_CHROME_EXECUTABLE).uid, 0);
  assert.equal(fs.statSync('/usr/bin/setpriv').uid, 0);
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\s*0000000000000000$/m);
  assert.match(status, /^NoNewPrivs:\s*1$/m);
  const hostInterfaces = fs.readdirSync('/sys/class/net');
  assert.deepEqual(hostInterfaces, ['lo']);

  let seeded = false, seedCount = 0, browser, connection;
  const sessionValue = crypto.randomBytes(12).toString('hex');
  const server = http.createServer((request, response) => {
    if (request.url === '/seed' && !seeded) {
      seeded = true; seedCount++;
      response.setHeader('Set-Cookie', `directory_fixture_session=${sessionValue}; HttpOnly; Path=/`);
    }
    response.end('<!doctype html><title>Synthetic directory session</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const diagnosticFile = path.join(root, 'logs/browser-verification.log');
  fs.writeFileSync(diagnosticFile, '', { mode: 0o600 });
  const options = { stateRoot: path.join(root, 'browser/service-verification'), socketRoot: process.env.DISPATCH_RUNTIME_ROOT,
    // This acceptance-only origin is inside the guest, without an external proxy.
    directoryNetwork: false,
    spawnImpl: (executable, args, selected) => {
      const stdio = [...selected.stdio]; stdio[2] = 'pipe';
      const child = spawn(executable, args, { ...selected, stdio });
      child.stderr.on('data', data => fs.appendFileSync(diagnosticFile, data));
      child.on('error', error => fs.appendFileSync(diagnosticFile, `${error.code}\n`));
      return child;
    },
  };
  const cookies = async () => (await connection.command('Network.getCookies', { urls: [origin] })).cookies;
  try {
    browser = await new ChromeBrowserRuntime(options).launch({ provider: 'paycom', profile: 'synthetic-directory-session' });
    let target = await createTarget(browser.endpoint, `${origin}/seed`);
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    for (let i = 0; i < 100 && !(await cookies()).some(cookie => cookie.value === sessionValue); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok((await cookies()).some(cookie => cookie.name === 'directory_fixture_session' && cookie.value === sessionValue));
    // Inspect Chrome's own sandbox report; no unsafe launch flags are added.
    const sandboxTarget = await createTarget(browser.endpoint, 'chrome://sandbox');
    const sandboxConnection = await CdpConnection.connect(sandboxTarget.webSocketDebuggerUrl);
    let sandboxText = '';
    try {
      for (let i = 0; i < 100; i++) {
        sandboxText = (await sandboxConnection.command('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.value || '';
        if (sandboxText.includes('Seccomp')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.match(sandboxText, /Seccomp[^\n]*\s+Yes/i);
      assert.match(sandboxText, /PID namespaces?[^\n]*\s+Yes/i);
    } finally { sandboxConnection.close(); }
    connection.close(); connection = null;
    await browser.close(); browser = null;
    const restarted = new ChromeBrowserRuntime(options);
    await restarted.reconcile();
    browser = await restarted.launch({ provider: 'paycom', profile: 'synthetic-directory-session' });
    target = await createTarget(browser.endpoint, 'about:blank');
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
    assert.ok((await cookies()).some(cookie => cookie.name === 'directory_fixture_session' && cookie.value === sessionValue));
    assert.equal(seedCount, 1);
    process.stdout.write(JSON.stringify({ ok: true, id: process.env.DISPATCH_RUNTIME_KEY,
      browser: 'launched', sandbox: 'enabled', sessionCookie: 'retained-after-restart', isolation: 'passed',
      pidNamespace: fs.readlinkSync('/proc/self/ns/pid') }) + '\n');
  } finally {
    connection?.close(); await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
