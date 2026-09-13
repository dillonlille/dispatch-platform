'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PaycomStore, stageCandidate, cleanupStage } = require('../src/store');
const { periodFromEnd } = require('../src/timecard-period');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('../src/resource-links');
const { rosterRow, timecardRecord } = require('./helpers');
const { createPublicationBaseline } = require('dispatch-protocol/contracts/src/publication-baseline');
const { verifyPublicationContinuity } = require('../src/publication-continuity');

test('continuity audits active publication content, target and original producer identities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-sourceation-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, 'stage'); fs.mkdirSync(stageRoot, { mode: 0o700 });
  const database = path.join(root, 'paycom.sqlite3');
  let store = new PaycomStore(database);
  const period = periodFromEnd('2026-09-05');
  const rows = [rosterRow('Z999', 'Synthetic Fixture')];
  const proof = { target: period.end, publications: {} };
  function publish(name, candidate) {
    const runId = `run_fixture_${name}`;
    const stage = stageCandidate(stageRoot, { target: period.end, attempt: 1,
      collectedAt: '2026-09-04T12:00:00.000Z', runId, ...candidate });
    try {
      const value = store.publish(stage);
      proof.publications[name] = { id: value.publicationId, originRunId: runId, contentSha256: value.contentSha256 };
      return value;
    } finally { cleanupStage(stage, stageRoot); }
  }
  try {
    publish('payPeriods', { kind: 'pay_periods', metadata: {},
      rows: [{ start: period.start, end: period.end, key: period.key, relation: 'current' }] });
    const roster = publish('roster', { kind: 'roster', metadata: {}, rows });
    publish('timecards', { kind: 'timecards', periodKey: period.key,
      metadata: { periodStart: period.start, periodEnd: period.end, mode: 'full',
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256 },
      rows: [{ employeeCode: 'Z999', employeeName: 'Synthetic Fixture', record: timecardRecord('Z999'), sourceSha256: 'b'.repeat(64) }] });
    publish('resourceLinks', { kind: 'resource_links', periodKey: period.key,
      metadata: { resourceType: TIMECARD_SUMMARY, periodStart: period.start, periodEnd: period.end,
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256, routeVersion: ROUTE_VERSION },
      rows: linkRows(TIMECARD_SUMMARY, rows, period) });
  } finally { store.close(); }
  const baseline = createPublicationBaseline(proof.target, proof.publications);
  assert.deepEqual(verifyPublicationContinuity(database, { mode: 'capture' }), { status: 'verified', publicationBaseline: baseline });
  assert.deepEqual(verifyPublicationContinuity(database, { mode: 'verify', baseline }), { status: 'verified', publicationBaselineDigest: baseline.digest });
  for (const alter of [
    value => { value.publications.timecards.contentSha256 = '0'.repeat(64); },
    value => { value.publications.roster.originRunId = 'run_substituted'; },
    value => { value.publications.resourceLinks.id = 'pub_substituted'; },
    value => { value.target = '2026-09-19'; },
  ]) {
    const value = structuredClone(proof); alter(value);
    assert.throws(() => verifyPublicationContinuity(database, { mode: 'verify', baseline: createPublicationBaseline(value.target, value.publications) }), /first_publication_failed/);
  }
  store = new PaycomStore(database);
  try {
    const changedRows = [rosterRow('Z999', 'Synthetic Updated')];
    const roster = publish('roster', { kind: 'roster', metadata: {}, rows: changedRows });
    publish('timecards', { kind: 'timecards', periodKey: period.key,
      metadata: { periodStart: period.start, periodEnd: period.end, mode: 'full',
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256 },
      rows: [{ employeeCode: 'Z999', employeeName: 'Synthetic Updated', record: timecardRecord('Z999'), sourceSha256: 'c'.repeat(64) }] });
    publish('resourceLinks', { kind: 'resource_links', periodKey: period.key,
      metadata: { resourceType: TIMECARD_SUMMARY, periodStart: period.start, periodEnd: period.end,
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256, routeVersion: ROUTE_VERSION },
      rows: linkRows(TIMECARD_SUMMARY, changedRows, period) });
  } finally { store.close(); }
  const updated = verifyPublicationContinuity(database, { mode: 'capture' }).publicationBaseline;
  assert.notEqual(updated.digest, baseline.digest);
  assert.throws(() => verifyPublicationContinuity(database, { mode: 'verify', baseline }), /first_publication_failed/);
  assert.equal(verifyPublicationContinuity(database, { mode: 'verify', baseline: updated }).publicationBaselineDigest, updated.digest);

});
