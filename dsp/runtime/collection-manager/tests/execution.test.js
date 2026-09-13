'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, spec } = require('./helpers');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('../src/manager');
const control = require('../src/execution-control');
const { nextWake, nextCron } = require('../src/next-wake');

test('Core owns the schedule clock after adoption, including process restart and replay', async t => {
  const c = fixture(); t.after(() => fs.rmSync(c.root, { recursive: true, force: true }));
  let store = new CollectionStore(c.paths); store.applySpec(spec());
  store.setNextDue('fixture-interval', Date.now() - 1000);
  control.command(store, 'adopt', null);
  let manager = new CollectionManager(store, { tickMs: 100000 }); await manager.start();
  assert.equal(store.runCount(), 0, 'startup cannot fire a schedule independently');
  const due = await nextWake(store);
  control.command(store, 'tick', due); await manager.tick();
  assert.equal(store.runCount(), 1);
  await manager.stop(); store.close();
  store = new CollectionStore(c.paths); manager = new CollectionManager(store, { tickMs: 100000 });
  await manager.start();
  control.command(store, 'tick', due); await manager.tick();
  assert.equal(store.runCount(), 1, 'repeated delivery of the same clock does not duplicate the run');
  assert.equal(control.read(store.db).completedAt, due);
  await manager.stop(); store.close();
});

test('drain waits for an asynchronous scheduling resolver and prevents new claims', async t => {
  const c = fixture(); t.after(() => fs.rmSync(c.root, { recursive: true, force: true }));
  const store = new CollectionStore(c.paths); store.applySpec(spec());
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const manager = new CollectionManager(store, { tickMs: 100000 });
  control.command(store, 'adopt', Date.now());
  manager.scheduleCollections = async () => { reached(); await new Promise(resolve => { release = resolve; }); };
  const starting = manager.start(); await waiting;
  const draining = control.command(store, 'drain', null);
  assert.equal(control.read(store.db).acknowledged, null);
  release(); await starting;
  assert.equal(control.read(store.db).acknowledged, draining.generation);
  store.enqueuePlan('fixture-snapshot'); await manager.tick();
  assert.equal(store.db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n, 0);
  assert.equal((await nextWake(store)) <= Date.now(), true, 'queued work remains represented in the wake deadline');
  await manager.stop(); store.close();
});

test('cron wake times preserve DST boundaries and weekly calendar rules', async () => {
  assert.equal(new Date(await nextCron('30 1 * * *', 'America/Los_Angeles', Date.parse('2026-11-01T08:30:00Z'))).toISOString(), '2026-11-01T09:30:00.000Z');
  assert.equal(new Date(await nextCron('30 2 * * *', 'America/Los_Angeles', Date.parse('2026-03-08T08:00:00Z'))).toISOString(), '2026-03-09T09:30:00.000Z');
  assert.equal(new Date(await nextCron('0 10 * * 1', 'UTC', Date.parse('2026-09-11T00:00:00Z'))).toISOString(), '2026-09-14T10:00:00.000Z');
});

test('damaged external-clock state fails closed instead of reverting to autonomous schedules', t => {
  const c = fixture(); t.after(() => fs.rmSync(c.root, { recursive: true, force: true }));
  const store = new CollectionStore(c.paths); t.after(() => store.close());
  store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('core_execution_v1', '{"version":1}');
  assert.throws(() => control.read(store.db), /execution_control_invalid/);
  assert.throws(() => control.command(store, 'adopt'), /execution_control_invalid/);
  assert.equal(store.runCount(), 0);
});
