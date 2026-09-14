import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchSandbox } from '../services/browsers/sandbox.js';
import { configuration } from '../services/config.js';

// Checks the actual host without visiting a provider or using credentials.
fs.mkdirSync('.runtime', { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.resolve('.runtime/browser-preflight-'));
try {
  const bundle = path.join(root, 'services/runtime');
  fs.mkdirSync(path.join(bundle, 'node_modules'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.resolve('.build/node_modules'), path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.cpSync(path.resolve('.build/services/runtime/provider'), path.join(bundle, 'provider'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(bundle, 'auth-worker.js'),
    `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { ChromeBrowserRuntime } = require('./provider/auth/browser-runtime.js');
    const { CdpConnection, createTarget } = require('./provider/auth/cdp.js');
    const runtime = new ChromeBrowserRuntime({ stateRoot: '/profile/profiles', executable: process.argv[2], transport: 'tcp', directoryNetwork: true });
    let browser, connection;
    try {
      browser = await runtime.launch({ provider: 'paycom', profile: 'preflight', nativeInput: true });
      const target = await createTarget(browser.endpoint, 'chrome://sandbox');
      connection = await CdpConnection.connect(target.webSocketDebuggerUrl);
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log(await connection.evaluate('document.body.innerText'));
      await connection.command('Page.navigate', { url: 'about:blank' });
      await new Promise(resolve => setTimeout(resolve, 200));
      await connection.evaluate('document.body.innerHTML="<input id=check>"');
      const rect = await connection.evaluate('(()=>{const r=document.querySelector("input").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
      await browser.nativeInput.click(connection, rect.x, rect.y);
      await browser.nativeInput.type('00Native !?');
      if (await connection.evaluate('document.querySelector("input").value') !== '00Native !?') throw Error('native_input_failed');
      console.log('Native OS input verified');
    } finally { connection?.close(); await browser?.close(); }

  `,
  );
  for (const name of ['profile', 'run']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const child = launchSandbox(
    configuration({ runtimeBundle: bundle, providerMode: 'native' }),
    path.join(root, 'profile'),
    path.join(root, 'run'),
  );
  child.stdin.end();
  let output = '',
    diagnostics = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, diagnostics);
    assert.match(output, /Layer 1 Sandbox\s+Namespace/);
    assert.match(output, /PID namespaces\s+Yes/);
    assert.match(output, /Network namespaces\s+Yes/);
    assert.match(output, /Seccomp-BPF sandbox\s+Yes/);
    assert.match(output, /Native OS input verified/);
    process.stdout.write(
      'Browser host verified: archived Chrome launch, native OS input, namespace and seccomp sandboxes are active inside the private worker.\n',
    );
  } finally {
    clearTimeout(timer);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
