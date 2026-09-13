'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { runCollector } = require('dispatch-runtime-kit/collection-manager/src/runner');
const { fixture } = require('./helpers');

test('collector timeout settles promptly and kills the collector process group', async () => {
  const { root } = fixture();
  const command = `${root}/descendant-collector`;
  const pidFile = `${root}/child.pid`;
  fs.writeFileSync(command, `#!/bin/sh\nsleep 30 &\nprintf '%s' "$!" > '${pidFile}'\nwait\n`, { mode: 0o700 });
  try {
    const started = Date.now();
    const task = runCollector({
      id: 'run_timeout', plan_id: 'timeout-plan', source_id: 'fixture-main', collector_id: 'fixture',
      auth_profile: null, sourceConfig: {}, method_id: 'fixture.timeout', input: {}, attempt: 1,
      timeout_seconds: 1, command,
    });
    const outcome = await task.promise;
    assert.equal(outcome.errorCode, 'collector_timeout');
    assert.ok(Date.now() - started < 3_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector cancellation allows bounded cooperative cleanup before SIGKILL', async () => {
  const { root } = fixture();
  const command = `${root}/cleanup-collector`;
  const ready = `${root}/ready`;
  const cleaned = `${root}/cleaned`;
  // Register cleanup before signalling readiness. A shell can fork its sleep
  // after the group signal, delaying its TERM trap until after the grace period.
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.once('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleaned)}, ''); process.exit(0); }, 2000));\nfs.writeFileSync(${JSON.stringify(ready)}, '');\nsetInterval(() => {}, 30000);\n`, { mode: 0o700 });
  try {
    const task = runCollector({
      id: 'run_cancel', plan_id: 'cancel-plan', source_id: 'fixture-main', collector_id: 'fixture',
      auth_profile: null, sourceConfig: {}, method_id: 'fixture.cancel', input: {}, attempt: 1,
      timeout_seconds: 30, command,
    });
    for (let index = 0; index < 100 && !fs.existsSync(ready); index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true);
    const started = Date.now();
    task.cancel();
    const outcome = await task.promise;
    assert.equal(outcome.cancelled, true);
    assert.equal(fs.existsSync(cleaned), true);
    assert.ok(Date.now() - started >= 1_800);
    assert.ok(Date.now() - started < 6_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
