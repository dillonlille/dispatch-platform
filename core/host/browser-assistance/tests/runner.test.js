'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runHermes, sessionProcesses } = require('../runner');

test('cancellation kills even a detached browser helper and removes disposable profile state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-runner-test-'));
  const profiles = path.join(root, 'profiles'); fs.mkdirSync(profiles);
  const profile = path.join(profiles, 'fixture'); fs.mkdirSync(profile);
  let temporary, childStarted;
  const ready = new Promise(resolve => { childStarted = resolve; });
  const control = new AbortController();
  const runner = runHermes({ profileDirectory: profile, hermesDirectory: root, pythonExecutable: '/usr/bin/python3', agentBrowserDirectory: '/usr/bin' }, 'ws://fixture', {
    signal: control.signal,
    spawnImpl: (command, args, options) => {
      temporary = options.env.TMPDIR;
      // Emulates an agent with a daemon that ignores graceful termination.
      const code = "import os,signal,subprocess,time; subprocess.Popen(['python3','-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'],start_new_session=True); time.sleep(60)";
      const child = spawn(command, ['-c', code], options); setTimeout(childStarted, 150); return child;
    },
  });
  const result = assert.rejects(runner, /assistance_cancelled/);
  await ready; control.abort(); await result;
  assert.deepEqual(sessionProcesses(temporary), []);
  assert.equal(fs.existsSync(temporary), false);
  assert.deepEqual(fs.readdirSync(profiles), ['fixture']);
  fs.rmSync(root, { recursive: true, force: true });
});
