'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  protection,
  activity,
  route,
  stages,
  fleet,
  filterFleet,
  needsAttention,
} = require('../public/assets/backups');
const at = (day) => `2026-09-0${day}T12:00:00.000Z`;
const record = (id, organizationId, day, status = 'verified') => ({
  id,
  organizationId,
  createdAt: at(day),
  status,
  name: organizationId || 'Platform Core',
});
const op = (id, organizationId, day, status = 'failed', kind = 'backup') => ({
  id,
  organizationId,
  createdAt: at(day),
  updatedAt: at(day),
  status,
  kind,
});
const data = (backups = [], operations = []) => ({
  organizations: [
    { id: 'one', name: 'DSP One' },
    { id: 'two', name: 'DSP Two' },
  ],
  backups,
  operations,
});

test('a failed request takes precedence over the last successful backup, until a newer success', () => {
  const state = data([record('old', 'one', 4)], [op('failed', 'one', 5)]);
  assert.equal(protection(state, 'one').status, 'failed');
  assert.equal(protection(state, 'one').verified.id, 'old');
  state.backups.push(record('new', 'one', 6));
  assert.equal(protection(state, 'one').status, 'verified');
  state.backups.reverse();
  assert.equal(protection(state, 'one').verified.id, 'new');
});

test('in-progress restores and verification have distinct truthful statuses', () => {
  const state = data(
    [record('old', 'one', 4), record('new', 'one', 6, 'pending')],
    [op('failed', 'one', 5), op('restore', 'one', 6, 'running', 'restore')],
  );
  assert.equal(protection(state, 'one').label, 'Restoring');
  state.operations = [];
  assert.equal(protection(state, 'one').label, 'Uploading backup');
  assert.equal(protection(state, 'one').verified.id, 'old');
});

test('a failed Core operation or another DSP cannot affect the selected DSP', () => {
  const state = data(
    [record('one-backup', 'one', 4)],
    [op('core-failed', null, 6), op('other-failed', 'two', 6)],
  );
  assert.equal(protection(state, 'one').status, 'verified');
  assert.equal(protection(state, 'core').status, 'failed');
  assert.equal(protection(state, 'two').status, 'failed');
  assert.equal(protection(state, 'missing').label, 'No backup yet');
});

test('expired backup does not claim protection when there is no verified recovery point', () => {
  assert.equal(protection(data([record('old', 'one', 3, 'expired')]), 'one').status, 'expired');
});

test('fleet summary includes unprotected DSPs without counting Core or double-counting work', () => {
  const state = data(
    [record('one', 'one', 4), record('core', null, 6)],
    [op('active', 'one', 5, 'running')],
  );
  const items = fleet(state);
  assert.equal(items.length, 2);
  assert.equal(items.filter(needsAttention).length, 1);
  assert.equal(items.filter((p) => p.status === 'running').length, 1);
  assert.equal(items.filter((p) => p.status === 'verified').length, 0);
  assert.equal(filterFleet(items, '', 'attention')[0].org.id, 'two');
});

test('DSP navigator combines name and status filters without crossing scopes', () => {
  const items = fleet(data([record('one', 'one', 4), record('two', 'two', 3, 'expired')]));
  assert.deepEqual(
    filterFleet(items, ' DSP ONE ', 'verified').map((p) => p.org.id),
    ['one'],
  );
  assert.equal(filterFleet(items, 'one', 'attention').length, 0);
  assert.equal(filterFleet(items, '', 'attention')[0].org.id, 'two');
  assert.equal(filterFleet(items, 'unmatched', 'all').length, 0);
});

test('history deduplicates a backup request and its artifact but retains restore events', () => {
  const state = data(
    [record('snapshot', 'one', 4), record('core-backup', null, 5)],
    [
      { ...op('backup-op', 'one', 4, 'completed'), backupId: 'snapshot' },
      { ...op('restore-op', 'one', 6, 'completed', 'restore'), backupId: 'snapshot' },
    ],
  );
  const events = activity(state);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.event),
    ['Restore', 'Backup', 'Backup'],
  );
  assert.equal(events[0].name, 'DSP One');
  assert.equal(events[1].name, 'Platform Core');
});

test('backup routes preserve scope and reject malformed or unexpected destinations', () => {
  assert.deepEqual(route('#/backups'), { mode: 'overview' });
  assert.deepEqual(route('#/backups/dsps/org_one/backups/backup_one'), {
    mode: 'detail',
    orgId: 'org_one',
    backupId: 'backup_one',
  });
  assert.deepEqual(route('#/backups/core/backups/backup_core'), {
    mode: 'detail',
    orgId: 'core',
    backupId: 'backup_core',
  });
  assert.deepEqual(route('#/backups/operations/op_one'), {
    mode: 'operation',
    operationId: 'op_one',
  });
  assert.deepEqual(route('#/backups/dsps/org_one/history'), {
    mode: 'dsp-history',
    orgId: 'org_one',
  });
  for (const hash of ['#/backups/dsps/%ZZ', '#/backups/unknown', '#/backups/history/extra'])
    assert.equal(route(hash).mode, 'missing');
});

test('progress never marks pending verification or failed recovery as complete', () => {
  assert.deepEqual(
    stages({ kind: 'backup', phase: 'uploading', status: 'running' }).map((s) => s.status),
    ['done', 'done', 'active', 'pending'],
  );
  assert.equal(
    stages({ kind: 'restore', phase: 'restoring', status: 'running' })[1].status,
    'active',
  );
  assert.equal(
    stages({ kind: 'restore', phase: 'recovering', status: 'running' }).every(
      (s) => s.status === 'pending',
    ),
    true,
  );
  assert.equal(
    stages({ kind: 'restore', phase: 'completed', status: 'completed' }).every(
      (s) => s.status === 'done',
    ),
    true,
  );
});

test('full-system recovery points remain addressable and filterable without guessing their category', () => {
  const state = data([], [{ ...op('request', null, 5, 'completed'), setId: 'scheduled-set', category: 'scheduled' }]);
  state.sets = [
    { id: 'scheduled-set', createdAt: at(5), status: 'verified' },
    { id: 'unknown-trigger', createdAt: at(4), status: 'incomplete' },
    { id: 'removed-set', createdAt: at(3), status: 'deleted' },
  ];
  const sets = activity(state).filter(e => e.source === 'set');
  assert.equal(sets.length, 2);
  assert.equal(sets[0].category, 'scheduled');
  assert.equal(sets[1].category, null);
  const { scope } = require('../public/assets/backups');
  assert.equal(scope(sets[0]), 'system');
  assert.deepEqual(route('#/backups/sets/scheduled-set'), { mode: 'sets', setId: 'scheduled-set' });
  assert.deepEqual(route('#/backups/sets'), { mode: 'sets' });
  assert.equal(route('#/backups/sets/one/extra').mode, 'missing');
});
