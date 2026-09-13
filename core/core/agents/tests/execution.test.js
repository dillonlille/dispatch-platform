'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DirectoryExecution } = require('../../../host/controller/execution');
const { saveStatus } = require('../../../shared/published/status');
const { success, failure } = require('../../../shared/contracts/src/result');

function fixture(t) {
  require('../../../shared/plugin-sdk/catalog').configureCatalog(() => [require('../../../tests/fixtures/paycom-plugin.json')]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-execution-'));
  const paths = { local: path.join(root, 'local') };
  for (const name of ['local', 'local/state', 'local/config']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE installations(runtime_key TEXT PRIMARY KEY,organization_id TEXT,status TEXT,revision INTEGER,backend TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE directory_lifecycle_requests(organization_id TEXT,status TEXT);
    CREATE TABLE dsp_removals(organization_id TEXT);
    CREATE TABLE dsp_plugins(organization_id TEXT,plugin_id TEXT,desired_state TEXT,applied_state TEXT,revision INTEGER,applied_revision INTEGER);`);
  let now = 100000;
  const active = new Set(), calls = [], dsps = new Map(), busy = new Set(), paused = new Set(), schedule = new Map(), delivered = new Map();
  let execution;
  const manager = { journal: { record: id => dsps.get(id) }, checkedDsp: record => record,
    async apply(action, operation, id) { calls.push([action, id]); if (action === 'start') active.add(id); else active.delete(id); } };
  const hub = { connected: id => active.has(id), async invoke(id, action, input) {
    assert.equal(active.has(id), true);
    if (action === 'runtime.execution') {
      if (input.command === 'tick' && schedule.get(id) <= now) schedule.delete(id);
      const status = { version: 1, busy: busy.has(id), drained: input.command === 'drain' && !busy.has(id), nextWakeAt: schedule.get(id) ?? null, observedAt: now };
      const data = { id: 'paycom-main-workforce', desiredState: paused.has(id) ? 'stopped' : 'running', activity: 'idle', queuedRunCount: 0, nextDueAt: null };
      saveStatus(path.join(dsps.get(id).root, 'data/published'), { execution: status, 'sync:paycom-main-workforce': success('found', data),
        system: success('ready', { components: { auth: {}, collections: { data: { manager: {} } } } }),
        connections: success('found', { items: [] }) }, now);
      return success('found', status);
    }
    if (action === 'sync.run_now') {
      const key = input.options.idempotencyKey;
      if (!delivered.has(key)) delivered.set(key, id);
      calls.push(['sync', id, key]);
      return success('queued', {});
    }
    calls.push([action, id]); return success('accepted', {});
  } };
  const options = { publishedReader: () => ({ workforce: { employees: () => failure('not_initialized') } }), paths, accessStore: { db }, manager, hub, configuration: { version: 1, enabled: true, idleMs: 1000, pollMs: 100, maxActive: 1 }, clock: () => now };
  function open() { execution = new DirectoryExecution(options); execution.wake = () => {}; }
  open();
  t.after(async () => { await execution.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, calls, active, busy, paused, schedule, delivered,
    get execution() { return execution; }, advance: ms => { now += ms; },
    async restart() { await execution.close(); open(); },
    add(n, { running = true } = {}) {
      const id = 'dsp_' + n.toString(16).padStart(32, '0'), org = 'org_' + n.toString(16).padStart(32, '0');
      const folder = path.join(root, id); fs.mkdirSync(folder, { mode: 0o700 }); fs.mkdirSync(path.join(folder, 'data'), { mode: 0o700 });
      dsps.set(id, { id, root: folder }); if (running) active.add(id);
      db.prepare("INSERT INTO installations VALUES(?,?,'ready',1,'directory_service_v1')").run(id, org);
      db.prepare("INSERT INTO organizations VALUES(?,'active')").run(org);
      db.prepare("INSERT INTO dsp_plugins VALUES(?,'paycom','enabled','enabled',1,1)").run(org);
      return id;
    } };
}

test('idle workers stop, reads never wake them, and concurrent manual requests share a durable job', async t => {
  const c = fixture(t), id = c.add(1);
  await c.execution.runPending(); c.advance(1200); await c.execution.runPending();
  assert.equal(c.active.has(id), false);
  assert.equal(c.execution.store.get(id).state, 'sleeping');
  assert.match(c.execution.store.get(id).operation_id, /^sleep_[a-f0-9]{32}$/);
  const before = c.calls.length;
  for (let i = 0; i < 20; i++) assert.equal((await c.execution.invoke(id, 'sync.status', { id: 'paycom-main-workforce' })).ok, true);
  assert.equal(c.calls.length, before);
  const input = { id: 'paycom-main-workforce', options: { idempotencyKey: 'same-click' } };
  const results = await Promise.all(Array.from({ length: 5 }, () => c.execution.invoke(id, 'sync.run_now', input)));
  assert.equal(new Set(results.map(result => result.data.request.id)).size, 1);
  await c.restart(); await c.execution.runPending();
  assert.equal(c.delivered.size, 1);
  assert.equal(c.calls.filter(call => call[0] === 'start').length, 1);
});

test('manual sync wakes a sleeping DSP even when its automatic schedule is paused', async t => {
  const c = fixture(t), id = c.add(1); c.paused.add(id);
  await c.execution.runPending(); c.advance(1200); await c.execution.runPending();
  assert.equal(c.active.has(id), false);
  assert.equal((await c.execution.invoke(id, 'sync.status', { id: 'paycom-main-workforce' })).data.desiredState, 'stopped');
  const result = await c.execution.invoke(id, 'sync.run_now', { id: 'paycom-main-workforce', options: { idempotencyKey: 'paused-manual' } });
  assert.equal(result.ok, true);
  await c.execution.runPending(); assert.equal(c.delivered.get('paused-manual'), id);
});

test('initial publication keeps existing worker reads available without waking a sleeping DSP', async t => {
  const c = fixture(t), id = c.add(1);
  await c.execution.runPending();
  assert.equal((await c.execution.invoke(id, 'workforce.employees', { query: {} })).ok, true);
  assert.equal(c.calls.filter(call => call[0] === 'workforce.employees').length, 1);
  c.advance(1200); await c.execution.runPending();
  const before = c.calls.length;
  assert.equal((await c.execution.invoke(id, 'workforce.employees', { query: {} })).status, 'not_initialized');
  assert.equal(c.calls.length, before);
});

test('scheduled work survives Core restart while active authentication prevents sleep', async t => {
  const c = fixture(t), id = c.add(1); c.schedule.set(id, 110000);
  await c.execution.runPending(); c.busy.add(id); c.advance(1200); await c.execution.runPending();
  assert.equal(c.active.has(id), true);
  c.busy.delete(id); c.advance(1200); await c.execution.runPending();
  assert.equal(c.active.has(id), false);
  await c.restart(); c.advance(10000); await c.execution.runPending();
  assert.equal(c.active.has(id), true);
  assert.equal(c.schedule.has(id), false);
});

test('suspension and plugin revocation fence queued work; invalid cross-DSP identity fails', async t => {
  const c = fixture(t), id = c.add(1);
  await c.execution.runPending(); c.advance(1200); await c.execution.runPending();
  await c.execution.invoke(id, 'sync.run_now', { id: 'paycom-main-workforce', options: { idempotencyKey: 'suspended-job' } });
  c.db.prepare("UPDATE installations SET status='suspended'").run();
  await c.execution.runPending(); assert.equal(c.active.has(id), false); assert.equal(c.delivered.size, 0);
  assert.equal((await c.execution.invoke('dsp_' + 'f'.repeat(32), 'sync.status', { id: 'paycom-main-workforce' })).ok, false);
  c.db.prepare("UPDATE installations SET status='ready'").run();
  c.db.prepare("UPDATE dsp_plugins SET desired_state='disabled'").run(); c.advance(61000);
  await c.execution.runPending(); assert.equal(c.delivered.size, 0);
  assert.equal(c.execution.store.latestJob(id).status, 'failed');
  assert.equal((await c.execution.invoke(id, 'workforce.employees', { query: {} })).status, 'plugin_disabled');
});

test('worker concurrency is bounded and a waiting DSP proceeds once a slot is released', async t => {
  const c = fixture(t), first = c.add(1, { running: false }), second = c.add(2, { running: false });
  await c.execution.runPending(); assert.equal(c.active.size, 1);
  c.advance(1200); await c.execution.runPending();
  assert.ok(c.active.size <= 1);
  c.advance(150); await c.execution.runPending();
  assert.equal(c.active.size, 1); assert.equal(c.active.has(second), true); assert.equal(c.active.has(first), false);
});
