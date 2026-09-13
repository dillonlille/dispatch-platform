'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PaycomStore, stageCandidate, cleanupStage } = require('../src/store');
const { periodFromEnd } = require('../src/timecard-period');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('../src/resource-links');
const { timecardRecord, rosterRow } = require('./helpers');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-paycom-store-'));
  fs.chmodSync(root, 0o700);
  return { root, staging: path.join(root, 'staging'), database: path.join(root, 'db', 'paycom.sqlite3') };
}

function publish(store, staging, candidate) {
  const stage = stageCandidate(staging, candidate);
  try { return store.publish(stage); }
  finally { cleanupStage(stage, staging); }
}

test('staged roster publication is atomic, private, versioned, and idempotent', () => {
  const { root, staging, database } = fixture();
  const store = new PaycomStore(database);
  try {
    const candidate = {
      kind: 'roster', target: '2026-08-22', runId: 'run-roster-1', attempt: 1, collectedAt: '2026-08-25T20:00:00.000Z',
      metadata: { sourceSha256: 'a'.repeat(64) }, rows: [rosterRow()],
    };
    const first = publish(store, staging, candidate);
    assert.equal(first.disposition, 'published');
    assert.equal(store.audit('roster').verified, true);
    const second = publish(store, staging, { ...candidate, runId: 'run-roster-2', collectedAt: '2026-08-25T20:01:00.000Z' });
    assert.equal(second.disposition, 'no_change');
    assert.equal(second.publicationId, first.publicationId);
    assert.equal(fs.statSync(database).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(staging), []);
    assert.throws(() => publish(store, staging, { ...candidate, runId: 'run-bad', rows: [] }), /candidate_invalid/);
    assert.equal(store.audit('roster').publicationId, first.publicationId);
    const third = publish(store, staging, { ...candidate, runId: 'run-roster-3', collectedAt: '2026-08-25T20:02:00.000Z', metadata: { sourceSha256: 'b'.repeat(64) }, rows: [rosterRow('A001', 'Beta')] });
    const fourth = publish(store, staging, { ...candidate, runId: 'run-roster-4', collectedAt: '2026-08-25T20:03:00.000Z', metadata: { sourceSha256: 'c'.repeat(64) }, rows: [rosterRow('A001', 'Gamma')] });
    assert.equal(store.audit('roster').publicationId, fourth.publicationId);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications WHERE kind=? AND target=?').get('roster', candidate.target).count, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications WHERE id=?').get(third.publicationId).count, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('complete timecard publication reconciles exactly to the active roster', () => {
  const { root, staging, database } = fixture();
  const store = new PaycomStore(database);
  const period = periodFromEnd('2026-09-05');
  try {
    const rosterResult = publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-roster', attempt: 1, collectedAt: '2026-08-25T20:00:00.000Z',
      metadata: {}, rows: [rosterRow('A001', 'One'), rosterRow('A002', 'Two')],
    });
    const result = publish(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-timecards', attempt: 1, collectedAt: '2026-08-25T20:02:00.000Z',
      metadata: {
        periodStart: period.start, periodEnd: period.end, mode: 'full',
        rosterPublicationId: rosterResult.publicationId,
        rosterContentSha256: rosterResult.contentSha256,
      },
      rows: [
        { employeeCode: 'A001', employeeName: 'One', record: timecardRecord('A001'), sourceSha256: 'b'.repeat(64) },
        { employeeCode: 'A002', employeeName: 'Two', record: timecardRecord('A002'), sourceSha256: 'c'.repeat(64) },
      ],
    });
    assert.equal(result.disposition, 'published');
    assert.deepEqual(store.reconcileCurrent(period.end), {
      verified: true,
      code: 'verified',
      periodEnd: period.end,
      rosterPublicationId: store.active('roster').id,
      timecardPublicationId: result.publicationId,
      activeEmployees: 2,
      timecards: 2,
      missing: [],
      unexpected: [],
      omitted: 0,
    });
    assert.equal(store.audit('timecards', period.end).verified, true);
    const exactAudit = store.auditTimecards(period.end);
    assert.equal(exactAudit.verified, true);
    assert.equal(exactAudit.rosterBindingValid, true);
    assert.deepEqual({
      activeEmployees: exactAudit.activeEmployees, timecards: exactAudit.timecards,
      missingCount: exactAudit.missingCount, unexpectedCount: exactAudit.unexpectedCount,
      duplicateCount: exactAudit.duplicateCount, identityMismatchCount: exactAudit.identityMismatchCount,
    }, { activeEmployees: 2, timecards: 2, missingCount: 0, unexpectedCount: 0, duplicateCount: 0, identityMismatchCount: 0 });
    store.db.prepare('UPDATE timecards SET period_total_hours=999 WHERE publication_id=? AND employee_code=?').run(result.publicationId, 'A001');
    const tampered = store.audit('timecards', period.end);
    assert.equal(tampered.verified, false);
    assert.equal(tampered.projectionValid, false);
    assert.equal(store.auditTimecards(period.end).verified, false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial membership and mismatched source URLs cannot replace a good timecard publication', () => {
  const { root, staging, database } = fixture();
  const store = new PaycomStore(database);
  const period = periodFromEnd('2026-09-05');
  try {
    const roster = publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-roster-safe', attempt: 1,
      collectedAt: '2026-08-25T20:00:00.000Z', metadata: {},
      rows: [rosterRow('A001', 'One'), rosterRow('A002', 'Two')],
    });
    const metadata = {
      periodStart: period.start, periodEnd: period.end, mode: 'full',
      rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256,
    };
    const good = publish(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-good', attempt: 1,
      collectedAt: '2026-08-25T20:01:00.000Z', metadata,
      rows: [
        { employeeCode: 'A001', employeeName: 'One', record: timecardRecord('A001'), sourceSha256: 'a'.repeat(64) },
        { employeeCode: 'A002', employeeName: 'Two', record: timecardRecord('A002'), sourceSha256: 'b'.repeat(64) },
      ],
    });
    assert.throws(() => publish(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-partial', attempt: 1,
      collectedAt: '2026-08-25T20:02:00.000Z', metadata,
      rows: [{ employeeCode: 'A001', employeeName: 'One', record: timecardRecord('A001'), sourceSha256: 'c'.repeat(64) }],
    }), /membership_mismatch/);
    const wrongUrl = { ...timecardRecord('A001'), sourceUrl: timecardRecord('A002').sourceUrl };
    assert.throws(() => stageCandidate(staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-wrong-url', attempt: 1,
      collectedAt: '2026-08-25T20:03:00.000Z', metadata,
      rows: [{ employeeCode: 'A001', employeeName: 'One', record: wrongUrl, sourceSha256: 'd'.repeat(64) }],
    }), /candidate_invalid/);
    publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-roster-revised', attempt: 1,
      collectedAt: '2026-08-25T20:04:00.000Z', metadata: { revision: 2 },
      rows: [rosterRow('A001', 'One'), rosterRow('A002', 'Two')],
    });
    const staleAudit = store.auditTimecards(period.end);
    assert.equal(staleAudit.verified, false);
    assert.equal(staleAudit.rosterBindingValid, false);
    assert.throws(() => publish(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-stale-roster', attempt: 1,
      collectedAt: '2026-08-25T20:05:00.000Z', metadata,
      rows: [
        { employeeCode: 'A001', employeeName: 'One', record: timecardRecord('A001'), sourceSha256: 'e'.repeat(64) },
        { employeeCode: 'A002', employeeName: 'Two', record: timecardRecord('A002'), sourceSha256: 'f'.repeat(64) },
      ],
    }), /membership_mismatch/);
    assert.equal(store.active('timecards', period.end).id, good.publicationId);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verification failure rolls back activation and stale attempts are fenced', () => {
  const { root, staging, database } = fixture();
  const store = new PaycomStore(database);
  const period = periodFromEnd('2026-09-05');
  try {
    const roster = publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-roster-fence', attempt: 1,
      collectedAt: '2026-08-25T20:00:00.000Z', metadata: {}, rows: [rosterRow('A001', 'One')],
    });
    const metadata = {
      periodStart: period.start, periodEnd: period.end, mode: 'full',
      rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256,
    };
    const good = publish(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-verified', attempt: 1,
      collectedAt: '2026-08-25T20:01:00.000Z', metadata,
      rows: [{ employeeCode: 'A001', employeeName: 'One', record: timecardRecord('A001'), sourceSha256: 'a'.repeat(64) }],
    });
    store.db.exec(`CREATE TRIGGER corrupt_new_timecard AFTER INSERT ON timecards BEGIN
      UPDATE timecards SET employee_name='Corrupt' WHERE publication_id=NEW.publication_id AND employee_code=NEW.employee_code;
    END;`);
    assert.throws(() => publish(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key, runId: 'run-corrupt', attempt: 1,
      collectedAt: '2026-08-25T20:02:00.000Z', metadata: { ...metadata, mode: 'incremental' },
      rows: [{ employeeCode: 'A001', employeeName: 'One', record: timecardRecord('A001'), sourceSha256: 'b'.repeat(64) }],
    }), /publication_verification_failed/);
    assert.equal(store.active('timecards', period.end).id, good.publicationId);
    store.db.exec('DROP TRIGGER corrupt_new_timecard');

    const newer = publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-recovered', attempt: 2,
      collectedAt: '2026-08-25T20:04:00.000Z', metadata: { revision: 2 }, rows: [rosterRow('A001', 'Newer')],
    });
    assert.throws(() => publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-recovered', attempt: 1,
      collectedAt: '2026-08-25T20:03:00.000Z', metadata: { revision: 1 }, rows: [rosterRow('A001', 'Older')],
    }), /stale_collection_attempt/);
    assert.equal(store.active('roster', period.end).id, newer.publicationId);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resource-link manifests cover the exact active period roster and invalidate on roster change', () => {
  const { root, staging, database } = fixture();
  const store = new PaycomStore(database);
  const period = periodFromEnd('2026-09-05');
  try {
    assert.equal(store.db.prepare('SELECT version FROM schema_meta').get().version, 5);
    const rosterRows = [rosterRow('A001', 'One'), rosterRow('A002', 'Two'), { ...rosterRow('A003', 'Three'), isActive: false }];
    const roster = publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-links-roster', attempt: 1,
      collectedAt: '2026-08-25T20:00:00.000Z', metadata: {}, rows: rosterRows,
    });
    const rows = linkRows(TIMECARD_SUMMARY, rosterRows.filter(row => row.isActive), period);
    const candidate = {
      kind: 'resource_links', target: period.end, periodKey: period.key,
      runId: 'run-links', attempt: 1, collectedAt: '2026-08-25T20:01:00.000Z',
      metadata: {
        resourceType: TIMECARD_SUMMARY, periodStart: period.start, periodEnd: period.end,
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256,
        routeVersion: ROUTE_VERSION,
      },
      rows,
    };
    const first = publish(store, staging, candidate);
    assert.equal(first.disposition, 'published');
    assert.deepEqual(first.membership, { rosterPublicationId: roster.publicationId, activeEmployees: 2, links: 2 });
    assert.equal(store.auditResourceLinks(TIMECARD_SUMMARY, period.end).verified, true);
    assert.equal(publish(store, staging, { ...candidate, runId: 'run-links-repeat' }).disposition, 'no_change');
    assert.throws(() => publish(store, staging, { ...candidate, runId: 'run-links-partial', rows: rows.slice(0, 1) }), /membership_mismatch/);
    assert.equal(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id, first.publicationId);

    publish(store, staging, {
      kind: 'roster', target: period.end, runId: 'run-links-roster-new', attempt: 1,
      collectedAt: '2026-08-25T20:02:00.000Z', metadata: { revision: 2 }, rows: rosterRows,
    });
    assert.equal(store.activeResourceLinks(TIMECARD_SUMMARY, period.end), null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate change-history compaction preserves published runs and one daily no-change row', () => {
  const { root, database } = fixture();
  const store = new PaycomStore(database);
  try {
    const insert = store.db.prepare(`INSERT INTO paycom_sync_change_history(
      run_id,source_id,target,business_date,business_timezone,observed_at,disposition,delta_json,persistence_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`);
    const common = ['paycom-main', '2026-09-05', '2026-08-30', 'America/Los_Angeles'];
    insert.run('history-1', ...common, '2026-08-30T01:00:00.000Z', 'no_change', '{}', '{}');
    insert.run('history-2', ...common, '2026-08-30T02:00:00.000Z', 'no_change', '{}', '{}');
    insert.run('history-3', ...common, '2026-08-30T03:00:00.000Z', 'no_change', '{}', '{}');
    insert.run('history-published', ...common, '2026-08-30T04:00:00.000Z', 'published', '{}', '{}');
    const compacted = store.compactSyncChangeHistory('2026-08-31T00:00:00.000Z');
    assert.equal(compacted.deleted, 2);
    assert.deepEqual(store.db.prepare(`SELECT run_id FROM paycom_sync_change_history ORDER BY run_id`).all().map(row => row.run_id),
      ['history-3', 'history-published']);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
