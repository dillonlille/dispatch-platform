'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { main, materializeSpec } = require('../src/control-cli');
const { fixture, spec } = require('./helpers');

async function call(argv, paths) {
  let output = '';
  const code = await main(argv, paths, chunk => { output += String(chunk); });
  return { code, value: JSON.parse(output.trim()) };
}

test('status and help do not initialize missing Collection Manager storage', async () => {
  const { root, paths } = fixture();
  try {
    const status = await call(['status'], paths);
    assert.equal(status.code, 0);
    assert.equal(status.value.status, 'not_initialized');
    assert.equal(fs.existsSync(paths.databaseRoot), false);
    assert.equal((await call(['help'], paths)).value.status, 'help');
    assert.equal(fs.existsSync(paths.databaseRoot), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manager specs materialize trusted project-relative collector commands', () => {
  const value = { collectors: [{ command: '${DISPATCH_PROJECT_ROOT}/plugins/paycom/backend/bin/dispatch-paycom-collector' }] };
  assert.equal(materializeSpec(value, '/opt/dispatch').collectors[0].command,
    '/opt/dispatch/plugins/paycom/backend/bin/dispatch-paycom-collector');
  assert.throws(() => materializeSpec({ collectors: [{ command: '${DISPATCH_PROJECT_ROOT}/../escape' }] }, '/opt/dispatch'),
    error => error.code === 'invalid_input');
});

test('agent CLI applies a spec, queues, drains, and inspects a real run', async () => {
  const { root, paths } = fixture();
  const file = path.join(root, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(spec()), { mode: 0o600 });
  try {
    const applied = await call(['apply', file], paths);
    assert.equal(applied.code, 0);
    assert.equal(applied.value.status, 'applied');
    const collectors = await call(['collectors', '1', '0'], paths);
    assert.equal(collectors.value.data.items[0].id, 'fixture');
    assert.equal(collectors.value.data.total, 1);
    assert.equal(collectors.value.data.hasMore, false);
    const plan = await call(['plan', 'fixture-snapshot'], paths);
    assert.equal(plan.value.data.method, 'fixture.snapshot');
    const queued = await call(['run', 'fixture-snapshot'], paths);
    assert.equal(queued.value.status, 'queued');
    const runId = queued.value.data.id;
    const drained = await call(['drain', '5000'], paths);
    assert.equal(drained.code, 0);
    assert.equal(drained.value.status, 'idle');
    const completed = await call(['run-status', runId], paths);
    assert.equal(completed.value.status, 'succeeded');
    assert.equal(completed.value.data.status, 'succeeded');
    const runs = await call(['runs', '1', '0'], paths);
    assert.equal(runs.value.data.items[0].id, runId);
    assert.equal(runs.value.data.total, 1);
    const unknownMethods = await call(['methods', 'missing'], paths);
    assert.equal(unknownMethods.value.status, 'collector_not_found');
    const missingInput = await call(['apply', path.join(root, 'missing.json')], paths);
    assert.equal(missingInput.code, 2);
    assert.equal(missingInput.value.status, 'input_not_found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drain timeout explicitly reports and cancels active runs', async () => {
  const { root, paths } = fixture();
  const command = path.join(root, 'slow-collector');
  const file = path.join(root, 'slow-spec.json');
  fs.writeFileSync(command, "#!/usr/bin/env node\nprocess.stdin.resume(); setTimeout(() => {}, 30000);\n", { mode: 0o700 });
  const configured = spec();
  configured.collectors[0].command = command;
  configured.collectors[0].methods = {
    'fixture.slow': { description: 'Slow', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, timeoutSeconds: 30, maxAttempts: 1, backoffSeconds: [], concurrencyKeys: [] },
  };
  configured.plans = [
    { id: 'fixture-slow', source: 'fixture-main', method: 'fixture.slow', schedule: { type: 'manual' }, input: {}, dependsOn: [], enabled: true },
  ];
  configured.syncs = [];
  fs.writeFileSync(file, JSON.stringify(configured), { mode: 0o600 });
  try {
    assert.equal((await call(['apply', file], paths)).code, 0);
    const queued = await call(['run', 'fixture-slow'], paths);
    const drained = await call(['drain', '100'], paths);
    assert.equal(drained.code, 1);
    assert.equal(drained.value.status, 'drain_timeout');
    assert.deepEqual(drained.value.data.cancelledRunIds, [queued.value.data.id]);
    const cancelled = await call(['run-status', queued.value.data.id], paths);
    assert.equal(cancelled.value.status, 'cancelled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
