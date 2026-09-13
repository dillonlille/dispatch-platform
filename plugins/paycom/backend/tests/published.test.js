'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PaycomStore, stageCandidate, cleanupStage } = require('../src/store');
const { periodFromEnd } = require('../src/timecard-period');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('../src/resource-links');
const { rosterRow, timecardRecord } = require('./helpers');
const { publishWorkforce } = require('../adapters/published');
const { LocalPaycomWorkforcePort } = require('../adapters/workforce');
const { createPublishedClient, SORTS } = require('../../dashboard/published');
const { WorkforceClient } = require('../../../../runtime/sdk/src/workforce-client');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-workforce-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'stage'); fs.mkdirSync(stageRoot, { mode: 0o700 });
  const database = path.join(root, 'paycom.sqlite3'), directory = path.join(root, 'published');
  function seed(end = '2026-09-05', name = 'Employee One') {
    const store = new PaycomStore(database), period = periodFromEnd(end);
    const rows = [rosterRow('Z999', name), rosterRow('A001', 'Employee 10'), rosterRow('B002', 'Employee 2')];
    const publish = candidate => {
      const stage = stageCandidate(stageRoot, { target: end, attempt: 1, collectedAt: '2026-09-04T12:00:00.000Z',
        runId: `run_${candidate.kind}_${end}_${name.replaceAll(' ', '_')}`, ...candidate });
      try { return store.publish(stage); } finally { cleanupStage(stage, stageRoot); }
    };
    try {
      const roster = publish({ kind: 'roster', metadata: {}, rows });
      publish({ kind: 'timecards', periodKey: period.key, metadata: { periodStart: period.start, periodEnd: end, mode: 'full',
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256 },
      rows: rows.map(row => ({ employeeCode: row.employeeCode, employeeName: row.employeeName, record: timecardRecord(row.employeeCode, end), sourceSha256: 'b'.repeat(64) })) });
      publish({ kind: 'resource_links', periodKey: period.key, metadata: { resourceType: TIMECARD_SUMMARY, periodStart: period.start, periodEnd: end,
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256, routeVersion: ROUTE_VERSION }, rows: linkRows(TIMECARD_SUMMARY, rows, period) });
    } finally { store.close(); }
  }
  const timezone = 'America/Los_Angeles';
  return { root, database, directory, seed,
    publish: () => publishWorkforce({ database, publishedDatabase: path.join(directory, 'paycom.sqlite3'), timezone }),
    published: createPublishedClient({ directory }).workforce,
    original: new WorkforceClient({ port: new LocalPaycomWorkforcePort({ database, timezone }) }) };
}

test('published reads match the existing workforce contract, including historical dates and sorting', async t => {
  const c = fixture(t); c.seed('2026-08-22'); c.seed();
  assert.equal((await c.publish()).changed, 2);
  assert.equal((await c.publish()).changed, 0);
  for (const method of ['snapshot', 'employees', 'employee', 'timecards', 'resourceLinks', 'punches', 'day']) {
    const inputs = method === 'employee' ? ['Z999'] : method === 'punches' || method === 'day' ? [{ date: '2026-08-23', limit: 2, offset: 1 }] : method === 'snapshot' ? [] : [{ limit: 2, offset: 1 }];
    const expected = await c.original[method](...inputs);
    assert.equal(expected.ok, true, JSON.stringify(expected));
    assert.deepEqual(await c.published[method](...inputs), expected, method);
  }
  for (const date of ['2026-08-09', '2026-08-24', '2026-10-01']) {
    for (const sort of SORTS) for (const direction of ['asc', 'desc']) {
      const query = { date, sort, direction, limit: 2, search: 'Employee' };
      assert.deepEqual(await c.published.day(query), await c.original.day(query));
    }
  }
  fs.renameSync(c.database, c.database + '.offline');
  assert.equal((await c.published.employees()).data.total, 3, 'reading has no source database or DSP dependency');
});

test('incomplete publication preserves the last complete period; changes replace only that period', async t => {
  const c = fixture(t); c.seed('2026-08-22'); c.seed(); await c.publish();
  const before = await c.published.day({ date: '2026-08-09' });
  c.seed('2026-09-05', 'Changed Employee'); await c.publish();
  assert.equal((await c.published.employee('Z999')).data.employee.employeeName, 'Changed Employee');
  assert.deepEqual(await c.published.day({ date: '2026-08-09' }), before);
  const store = new PaycomStore(c.database);
  store.db.prepare("DELETE FROM active_resource_link_publications WHERE target='2026-09-05'").run(); store.close();
  assert.equal((await c.publish()).changed, 0);
  assert.equal((await c.published.employee('Z999')).data.employee.employeeName, 'Changed Employee');
});

test('missing data stays unavailable and symlinked publications fail closed', async t => {
  const c = fixture(t);
  assert.equal((await c.published.employees()).status, 'not_initialized');
  c.seed(); await c.publish();
  const file = path.join(c.directory, 'paycom.sqlite3');
  fs.renameSync(file, file + '.actual'); fs.symlinkSync(file + '.actual', file);
  assert.equal((await c.published.employees()).status, 'unsafe_storage');
});

test('temporary publisher writes an atomic read model and exits, then unchanged periods need no worker', async t => {
  const c = fixture(t); c.seed();
  const job = require('../adapters/published-job');
  const options = { database: c.database, publishedDatabase: path.join(c.directory, 'paycom.sqlite3'), timezone: 'America/Los_Angeles' };
  assert.equal(job.needsPublication(options), true);
  assert.equal((await job.publish(options)).changed, 1);
  assert.equal(job.needsPublication(options), false);
  assert.equal((await job.publish(options)).changed, 0);
  assert.deepEqual(await c.published.day({ date: '2026-09-01' }), await c.original.day({ date: '2026-09-01' }));
});
