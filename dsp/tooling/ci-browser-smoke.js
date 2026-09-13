'use strict';

// A blank-page fixture only: never use this diagnostic with provider credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChromeBrowserRuntime } = require('../runtime/auth-broker/src/browser-runtime');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ci-browser-'));
  fs.chmodSync(root, 0o700);
  let diagnostics = '', browser;
  // This checks tool availability on a cold hosted runner, not startup latency.
  // Production and the real browser tests retain their normal startup limits.
  const runtime = new ChromeBrowserRuntime({ stateRoot: path.join(root, 'profiles'), directoryNetwork: false, startTimeoutMs: 60000,
    spawnImpl(command, args, options) {
      const stdio = [...options.stdio];stdio[2] = 'pipe';
      const child = spawn(command, args, { ...options, stdio });
      child.stderr.on('data', block => { if (diagnostics.length < 16000) diagnostics += block.toString().slice(0, 16000 - diagnostics.length); });
      return child;
    } });
  try {
    browser = await runtime.launch({ provider: 'paycom', profile: 'fixture', nativeInput: true });
    console.log('Blank native Chrome window started and will be cleaned up');
  } catch (error) {
    console.error(diagnostics);
    throw error;
  } finally {
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
