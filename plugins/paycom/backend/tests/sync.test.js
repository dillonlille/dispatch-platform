'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execute } = require('../src/collector');
const { authoritativeRosterBody, rosterAuthorityAssessment } = require('../src/browser');
const {
  canonicalBusinessTimecard, timecardBusinessSha256,
} = require('../src/fingerprints');
const { PaycomStore, validateCandidate, stageCandidate, cleanupStage } = require('../src/store');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('../src/resource-links');
const { planWorkforceMirror } = require('../src/sync-publication');
const { computeBusinessDelta } = require('../src/sync-delta');
const { timecardRecord } = require('./helpers');
const { boundedJson } = require('dispatch-runtime-kit/collection-manager/src/validation');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-paycom-sync-'));
  fs.chmodSync(root, 0o700);
  return {
    root,
    database: path.join(root, 'db', 'paycom.sqlite3'),
    staging: path.join(root, 'staging'),
  };
}

function publishCandidate(store, staging, candidate) {
  const stage = stageCandidate(staging, candidate);
  try { return store.publish(stage); }
  finally { cleanupStage(stage, staging); }
}

function activeWorkforceBase(store, target) {
  const roster = store.active('roster', target);
  const timecards = store.active('timecards', target);
  const links = store.activeResourceLinks(TIMECARD_SUMMARY, target)?.publication || null;
  return {
    rosterPublicationId: roster.id,
    rosterContentSha256: roster.content_sha256,
    timecardPublicationId: timecards.id,
    timecardContentSha256: timecards.content_sha256,
    resourceLinkPublicationId: links?.id || null,
    resourceLinkContentSha256: links?.content_sha256 || null,
  };
}

function employee(code, overrides = {}) {
  return {
    employeeCode: code,
    employeeName: `Employee ${code}`,
    status: 'A',
    lifecycleStatus: 'active',
    departmentCode: 'D1',
    departmentDesc: 'Driver',
    deliveryStationCode: 'S1',
    deliveryStationDesc: 'Station',
    positionTitle: 'Driver',
    payClass: 'PC',
    terminalGroup: 'TG',
    payType: 'Hourly',
    primarySupervisor: 'Supervisor',
    missingPunches: '0',
    totalHours: '8',
    totalOvertimeHours: '0',
    employeeApprovalPercentage: '0',
    supervisorApprovalPercentage: '0',
    isActive: true,
    isDriverDepartment: true,
    isDriverPosition: true,
    isActiveDriver: true,
    ...overrides,
  };
}

function rawEmployee(code, overrides = {}) {
  return {
    employeeCode: code,
    fullName: `Employee ${code}`,
    eestatus: 'A',
    allocation: { selections: [
      { categoryName: 'Department', isDepartment: true, code: 'D1', description: 'Driver' },
      { categoryName: 'Delivery Station Code', isDepartment: false, code: 'S1', description: 'Station' },
    ] },
    position: 'Driver',
    payClassCode: 'PC',
    terminalCode: 'TG',
    payType: 'Hourly',
    primarySupervisor: 'Supervisor',
    missingPunches: 0,
    totals: { totalHours: 8, otHours: 0 },
    approvalPercentages: { employee: 0, supervisor: 0 },
    ...overrides,
  };
}

function rosterBytes(rows) {
  return Buffer.from(JSON.stringify({ eeCodes: rows.map(row => row.employeeCode), employees: rows }));
}

function shadowTimecardRow(code, end = '2026-09-05', overrides = {}, observedAt = '2026-08-27T06:00:00.000Z') {
  const record = canonicalBusinessTimecard({ ...timecardRecord(code, end, 1), ...overrides });
  return {
    employeeCode: code,
    employeeName: `Employee ${code}`,
    record,
    sourceSha256: 'e'.repeat(64),
    businessSha256: timecardBusinessSha256(record),
    observedAt,
  };
}

function fixturePerformance(itemCount) {
  return { totalMs: 1, itemCount, workerCount: Math.min(3, itemCount), openedTargets: Math.min(3, itemCount), retryCount: 0 };
}

function syncRequest(runId = 'shadow-1') {
  return {
    protocolVersion: 1,
    runId,
    plan: 'paycom-current-workforce-sync',
    source: {
      id: 'paycom-main', collector: 'paycom', authProfile: 'paycom-main',
      config: { timezone: 'America/Los_Angeles', maxConcurrency: 3 },
    },
    method: 'sync.current-workforce',
    input: {
      reconcileBatchSize: 10,
      fullReconcileMinutes: 1440,
      lookbackPeriods: 1,
    },
    attempt: 1,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('timecard business identity ignores cache-buster evidence but detects business edits', () => {
  const first = timecardRecord('A001', '2026-09-05', 1);
  const second = timecardRecord('A001', '2026-09-05', 2);
  assert.equal(timecardBusinessSha256(first), timecardBusinessSha256(second));
  const canonical = canonicalBusinessTimecard(first);
  assert.equal(canonical.sourceUrl.includes('dispatch_timecards'), false);
  assert.notEqual(timecardBusinessSha256(canonical), timecardBusinessSha256({
    ...canonical,
    approvals: [['approved']],
  }));
  const businessSha256 = timecardBusinessSha256(canonical);
  assert.doesNotThrow(() => validateCandidate({
    kind: 'timecards', target: canonical.periodEnd, periodKey: canonical.periodKey,
    runId: 'semantic-1', attempt: 1, collectedAt: '2026-08-27T06:00:00.000Z',
    metadata: { periodStart: canonical.periodStart, periodEnd: canonical.periodEnd },
    rows: [{
      employeeCode: 'A001', employeeName: 'Employee A001', record: canonical,
      sourceSha256: 'a'.repeat(64), businessSha256, observedAt: '2026-08-27T06:00:00.000Z',
    }],
  }));
});

test('business delta classifies punch additions, edits, and nested approval changes without identities', () => {
  const before = shadowTimecardRow('A001');
  const after = structuredClone(before);
  after.record.days[0].punches[0].comment = 'changed';
  after.record.days[0].punches.push({
    ...structuredClone(after.record.days[0].punches[0]),
    ordinal: 2, slot: 'o2', kind: 'OUT DAY', displayTime: '05:00 PM',
    actualTime: '05:00 PM', roundedTime: '05:00 PM', comment: '',
  });
  after.record.approvals = [['approved']];
  after.businessSha256 = timecardBusinessSha256(after.record);
  const mirror = {
    rosterAddedCount: 0, rosterProfileChangedCount: 0, rosterSummaryChangedCount: 0,
    rosterRecordChangedCount: 0, timecardAddedCount: 0, timecardChangedCount: 1,
    retainedMissingCount: 0, becameUnknownCount: 0, returnedFromUnknownCount: 0,
    unknownEmployeeCount: 0, deactivatedCount: 0, reactivatedCount: 0, activeEmployeeCount: 1,
  };
  const delta = computeBusinessDelta([before], [after], mirror);
  assert.equal(delta.timecards.changedCount, 1);
  assert.equal(delta.days.changedCount, 1);
  assert.equal(delta.punches.addedCount, 1);
  assert.equal(delta.punches.addedByKind.outDayCount, 1);
  assert.equal(delta.punches.editedCount, 1);
  assert.equal(delta.details.approvalSectionsChangedCount, 1);
  assert.equal(JSON.stringify(delta).includes('A001'), false);
  assert.equal(JSON.stringify(delta).includes('05:00 PM'), false);
});

test('authoritative roster policy rejects filtered and incomplete request shapes', () => {
  const body = {
    eeCodes: ['A001', 'A002'], q: '', isAdvancedFilterApplied: false,
    onlyBorrowedEmployees: false, payClassCodes: [], selectedEarnings: [], approvalMode: null,
    skip: 0, take: 2, getCount: true,
  };
  assert.equal(authoritativeRosterBody(body), true);
  assert.equal(authoritativeRosterBody({ ...body, q: 'employee' }), false);
  assert.deepEqual(rosterAuthorityAssessment({ ...body, q: 'employee' }), {
    observable: false, authoritative: false, code: 'roster_filter_search',
  });
  assert.equal(rosterAuthorityAssessment({ ...body, take: 1 }).code, 'roster_filter_page_size');
  assert.equal(authoritativeRosterBody({ ...body, isAdvancedFilterApplied: true }), false);
  assert.deepEqual(rosterAuthorityAssessment({ ...body, isAdvancedFilterApplied: true }), {
    observable: true, authoritative: false, code: 'roster_filters_present',
  });
  assert.equal(authoritativeRosterBody({ ...body, onlyBorrowedEmployees: true }), false);
  assert.deepEqual(rosterAuthorityAssessment({ ...body, payClassCodes: ['selected'] }), {
    observable: true, authoritative: false, code: 'roster_filters_present',
  });
  assert.equal(authoritativeRosterBody({ ...body, take: 1 }), false);
  assert.equal(authoritativeRosterBody({ ...body, skip: 1 }), false);
});

test('shadow observations retain missing employees and are retry-idempotent', () => {
  const { root, database } = fixture();
  const store = new PaycomStore(database);
  const base = {
    sourceId: 'paycom-main', target: '2026-09-05', observedAt: '2026-08-27T06:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
  };
  try {
    const baseline = store.observeWorkforceShadow({
      ...base, runId: 'shadow-1', employees: [employee('A001'), employee('A002')],
    });
    assert.deepEqual(baseline, {
      baseline: true, absencePolicy: 'retain', sourceCompleteness: 'observation_only',
      observedCount: 2, addedCount: 0, profileChangedCount: 0,
      summaryChangedCount: 0, missingCount: 0, candidateCount: 0,
    });
    const changed = store.observeWorkforceShadow({
      ...base, runId: 'shadow-2', observedAt: '2026-08-27T06:15:00.000Z', sourceSha256: 'b'.repeat(64),
      employees: [employee('A001', { positionTitle: 'Lead', totalHours: '10' }), employee('A003')],
    });
    assert.equal(changed.addedCount, 1);
    assert.equal(changed.profileChangedCount, 1);
    assert.equal(changed.summaryChangedCount, 1);
    assert.equal(changed.missingCount, 1);
    assert.equal(changed.absencePolicy, 'retain');
    assert.equal(changed.candidateCount, 2);
    const repeated = store.observeWorkforceShadow({
      ...base, runId: 'shadow-3', observedAt: '2026-08-27T06:30:00.000Z', sourceSha256: 'c'.repeat(64),
      employees: [employee('A001', { positionTitle: 'Lead', totalHours: '10' }), employee('A003')],
    });
    assert.equal(repeated.absencePolicy, 'retain');
    assert.equal(repeated.missingCount, 1);
    assert.deepEqual(store.observeWorkforceShadow({
      ...base, runId: 'shadow-3', observedAt: '2026-08-27T06:31:00.000Z', sourceSha256: 'd'.repeat(64),
      employees: [employee('A001'), employee('A003')],
    }), repeated);
    assert.equal(JSON.stringify(repeated).includes('A002'), false);
    assert.equal(store.syncState('paycom-main', '2026-09-05').pendingRemovalCount, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shadow timecard selection rotates, prioritizes obvious changes, and performs due full reconciliation', () => {
  const { root, database } = fixture();
  const store = new PaycomStore(database);
  const target = '2026-09-05';
  const firstEmployees = ['A001', 'A002', 'A003', 'A004'].map(code => employee(code));
  const common = {
    sourceId: 'paycom-main', target, sourceSha256: 'a'.repeat(64),
    reconcileBatchSize: 2, fullReconcileMinutes: 60,
  };
  try {
    const firstPlan = store.planWorkforceShadow({
      sourceId: common.sourceId, target, observedAt: '2026-08-27T06:00:00.000Z',
      employees: firstEmployees, reconcileBatchSize: 2, fullReconcileMinutes: 60,
    });
    assert.deepEqual(firstPlan.selectedEmployees.map(row => row.employeeCode), ['A001', 'A002']);
    assert.equal(firstPlan.rotationCount, 2);
    assert.equal(firstPlan.fullReconciliation, false);
    const first = store.observeWorkforceShadow({
      ...common, runId: 'rotation-1', observedAt: '2026-08-27T06:00:00.000Z', employees: firstEmployees,
      timecardRows: firstPlan.selectedEmployees.map(row => shadowTimecardRow(row.employeeCode)),
    });
    assert.equal(first.timecardBaselineCount, 2);

    const changedEmployees = firstEmployees.map(row => {
      if (row.employeeCode === 'A001') return employee('A001', { totalHours: '10' });
      if (row.employeeCode === 'A002') return employee('A002', {
        status: 'I', isActive: false, isActiveDriver: false,
      });
      return row;
    });
    const secondPlan = store.planWorkforceShadow({
      sourceId: common.sourceId, target, observedAt: '2026-08-27T06:15:00.000Z',
      employees: changedEmployees, reconcileBatchSize: 2, fullReconcileMinutes: 60,
    });
    assert.deepEqual(secondPlan.selectedEmployees.map(row => row.employeeCode), ['A001', 'A003', 'A004']);
    assert.equal(secondPlan.obviousCandidateCount, 1);
    assert.equal(secondPlan.rotationCount, 2);
    const changedRecord = { approvals: [['approved']] };
    const second = store.observeWorkforceShadow({
      ...common, runId: 'rotation-2', observedAt: '2026-08-27T06:15:00.000Z',
      sourceSha256: 'b'.repeat(64), employees: changedEmployees,
      timecardRows: secondPlan.selectedEmployees.map(row => shadowTimecardRow(
        row.employeeCode, target, row.employeeCode === 'A001' ? changedRecord : {}, '2026-08-27T06:15:00.000Z',
      )),
    });
    assert.equal(second.timecardChangedCount, 1);
    assert.equal(second.timecardBaselineCount, 2);

    const notYetFull = store.planWorkforceShadow({
      sourceId: common.sourceId, target, observedAt: '2026-08-27T06:59:00.000Z',
      employees: changedEmployees, reconcileBatchSize: 2, fullReconcileMinutes: 60,
    });
    assert.equal(notYetFull.fullReconciliation, false);

    const fullPlan = store.planWorkforceShadow({
      sourceId: common.sourceId, target, observedAt: '2026-08-27T07:15:00.000Z',
      employees: changedEmployees, reconcileBatchSize: 2, fullReconcileMinutes: 60,
    });
    assert.equal(fullPlan.fullReconciliation, true);
    assert.equal(fullPlan.selectedEmployees.length, 3);
    const full = store.observeWorkforceShadow({
      ...common, runId: 'rotation-3', observedAt: '2026-08-27T07:15:00.000Z',
      sourceSha256: 'c'.repeat(64), employees: changedEmployees,
      timecardRows: fullPlan.selectedEmployees.map(row => shadowTimecardRow(
        row.employeeCode, target, row.employeeCode === 'A001' ? changedRecord : {}, '2026-08-27T07:15:00.000Z',
      )),
    });
    assert.equal(full.fullReconciliation, true);
    assert.equal(full.selectedTimecardCount, 3);
    assert.equal(full.timecardUnchangedCount, 3);
    assert.equal(store.syncState(common.sourceId, target).lastFullReconciledAt, '2026-08-27T07:15:00.000Z');
    assert.equal(store.planWorkforceShadow({
      sourceId: common.sourceId, target, observedAt: '2026-08-27T07:30:00.000Z',
      employees: changedEmployees, reconcileBatchSize: 2, fullReconcileMinutes: 60,
    }).fullReconciliation, false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workforce mirror planner applies additions and edits while retaining untrusted absences', () => {
  const period = { start: '2026-08-23', end: '2026-09-05', key: '2026-08-23_2026-09-05' };
  const priorRosterRows = [employee('A001'), employee('A002')];
  const priorTimecardRows = [shadowTimecardRow('A001'), shadowTimecardRow('A002')];
  const sourceEmployees = [
    employee('A001', { positionTitle: 'Lead', totalHours: '10' }),
    employee('A003'),
  ];
  const changedA001 = shadowTimecardRow('A001', period.end, { approvals: [['approved']] });
  const addedA003 = shadowTimecardRow('A003');
  const plan = planWorkforceMirror({
    period, priorRosterRows, priorTimecardRows, sourceEmployees,
    collectedTimecardRows: [changedA001, addedA003],
  });
  assert.equal(plan.hasChanges, true);
  assert.deepEqual(plan.rosterRows.map(row => row.employeeCode), ['A001', 'A002', 'A003']);
  assert.deepEqual(plan.timecardRows.map(row => row.employeeCode), ['A001', 'A002', 'A003']);
  assert.equal(plan.resourceLinkRows.length, 3);
  assert.deepEqual(plan.counts, {
    rosterAddedCount: 1,
    rosterProfileChangedCount: 1,
    rosterSummaryChangedCount: 1,
    rosterRecordChangedCount: 3,
    timecardAddedCount: 1,
    timecardChangedCount: 1,
    retainedMissingCount: 1,
    becameUnknownCount: 1,
    returnedFromUnknownCount: 0,
    unknownEmployeeCount: 1,
    deactivatedCount: 0,
    reactivatedCount: 0,
    activeEmployeeCount: 3,
  });
  assert.throws(() => planWorkforceMirror({
    period, priorRosterRows, priorTimecardRows, sourceEmployees,
    collectedTimecardRows: [changedA001],
  }), /timecard_refresh_required/);
});

test('atomic workforce publication activates additions and edits together and rolls back every pointer on failure', () => {
  const { root, database, staging } = fixture();
  const store = new PaycomStore(database);
  const period = { start: '2026-08-23', end: '2026-09-05', key: '2026-08-23_2026-09-05' };
  const priorRosterRows = [employee('A001'), employee('A002')];
  const priorTimecardRows = [shadowTimecardRow('A001'), shadowTimecardRow('A002')];
  try {
    const roster = publishCandidate(store, staging, {
      kind: 'roster', target: period.end, runId: 'atomic-prior-roster', attempt: 1,
      collectedAt: '2026-08-27T05:00:00.000Z', metadata: { sourceSha256: '1'.repeat(64) },
      rows: priorRosterRows,
    });
    publishCandidate(store, staging, {
      kind: 'timecards', target: period.end, periodKey: period.key,
      runId: 'atomic-prior-timecards', attempt: 1, collectedAt: '2026-08-27T05:01:00.000Z',
      metadata: {
        periodStart: period.start, periodEnd: period.end,
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256,
        mode: 'published_roster',
      },
      rows: priorTimecardRows,
    });
    publishCandidate(store, staging, {
      kind: 'resource_links', target: period.end, periodKey: period.key,
      runId: 'atomic-prior-links', attempt: 1, collectedAt: '2026-08-27T05:02:00.000Z',
      metadata: {
        resourceType: TIMECARD_SUMMARY, periodStart: period.start, periodEnd: period.end,
        rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256,
        routeVersion: ROUTE_VERSION,
      },
      rows: linkRows(TIMECARD_SUMMARY, priorRosterRows, period),
    });
    store.observeWorkforceShadow({
      sourceId: 'paycom-main', target: period.end, runId: 'atomic-baseline',
      observedAt: '2026-08-27T05:03:00.000Z', sourceSha256: '2'.repeat(64),
      employees: priorRosterRows,
      timecardRows: priorTimecardRows,
      reconcileBatchSize: 2, fullReconcileMinutes: 1440,
    });

    const sourceEmployees = [employee('A001', { positionTitle: 'Lead', totalHours: '10' }), employee('A003')];
    const collected = [
      shadowTimecardRow('A001', period.end, { approvals: [['approved']] }, '2026-08-27T06:00:00.000Z'),
      shadowTimecardRow('A003', period.end, {}, '2026-08-27T06:00:00.000Z'),
    ];
    const mirrorPlan = planWorkforceMirror({
      period, priorRosterRows, priorTimecardRows, sourceEmployees,
      collectedTimecardRows: collected,
    });
    const publishInput = {
      runId: 'atomic-sync-1', attempt: 1, collectedAt: '2026-08-27T06:00:00.000Z',
      businessTimezone: 'America/Los_Angeles', period, sourceSha256: '3'.repeat(64), sourceFormat: 'paycom-employees-json.v1',
      sourceEmployees, mirrorPlan, stagingRoot: staging,
      base: activeWorkforceBase(store, period.end),
      observation: {
        sourceId: 'paycom-main', target: period.end, runId: 'atomic-sync-1',
        observedAt: '2026-08-27T06:00:00.000Z', sourceSha256: '3'.repeat(64),
        employees: sourceEmployees,
        timecardRows: collected,
        reconcileBatchSize: 2, fullReconcileMinutes: 1440,
      },
    };
    const activeIdsBeforePreview = ['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id);
    const previewInput = {
      ...publishInput,
      runId: 'atomic-preview-1',
      observation: { ...publishInput.observation, runId: 'atomic-preview-1' },
    };
    const preview = store.previewWorkforceSync(previewInput);
    assert.equal(preview.disposition, 'no_change');
    assert.equal(preview.wouldPublish, true);
    assert.equal(preview.counts.rosterAddedCount, 1);
    assert.equal(preview.rosterPublicationId, undefined);
    assert.deepEqual(['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id), activeIdsBeforePreview);
    assert.deepEqual(fs.readdirSync(staging), []);
    const replayedPreview = store.previewWorkforceSync(previewInput);
    assert.equal(replayedPreview.wouldPublish, true);
    assert.deepEqual(replayedPreview.counts, preview.counts);
    assert.deepEqual(['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id), activeIdsBeforePreview);
    const result = store.publishWorkforceSync(publishInput);
    assert.equal(result.disposition, 'published');
    assert.equal(result.counts.rosterAddedCount, 1);
    assert.equal(result.counts.retainedMissingCount, 1);
    assert.equal(result.counts.becameUnknownCount, 1);
    assert.equal(result.businessDate, '2026-08-27');
    assert.equal(result.businessTimezone, 'America/Los_Angeles');
    assert.deepEqual(result.delta.timecards, {
      addedCount: 1, changedCount: 1, unchangedCount: 1, removedCount: 0,
    });
    assert.equal(result.delta.punches.addedCount, 1);
    assert.equal(result.delta.punches.addedByKind.inDayCount, 1);
    assert.equal(result.delta.punches.editedCount, 0);
    assert.equal(result.delta.details.approvalSectionsChangedCount, 1);
    assert.equal(result.persistence.verified, true);
    assert.equal(result.persistence.timecardCount, 3);
    assert.equal(result.persistence.dateRowCount, 3);
    assert.equal(result.persistence.selectedTimecardCount, 2);
    assert.equal(result.persistence.persistedSelectedTimecardCount, 2);
    assert.equal(result.persistence.selectedMismatchCount, 0);
    const persistedPunches = store.auditTimecardPersistence(period.end, period.start, collected);
    assert.equal(persistedPunches.verified, true);
    assert.equal(persistedPunches.punchCount, 3);
    assert.equal(persistedPunches.inDayPunchCount, 3);
    assert.equal(persistedPunches.inDayTimecardCount, 3);
    const mismatchedPersistence = store.auditTimecardPersistence(period.end, period.start, [
      shadowTimecardRow('A001', period.end),
    ]);
    assert.equal(mismatchedPersistence.verified, false);
    assert.equal(mismatchedPersistence.selectedMismatchCount, 1);
    const boundedReceipt = {
      ok: true, status: 'published', data: {
        method: 'sync.current-workforce', mode: 'additions_edits',
        businessDate: result.businessDate,
        businessTimezone: result.businessTimezone,
        mirror: result.counts,
        delta: result.delta,
        persistence: result.persistence,
        publications: {
          rosterPublicationId: result.rosterPublicationId,
          timecardPublicationId: result.timecardPublicationId,
          resourceLinkPublicationId: result.resourceLinkPublicationId,
        },
      },
    };
    assert.doesNotThrow(() => boundedJson(boundedReceipt, 262144));
    assert.equal(JSON.stringify(boundedReceipt).includes('A001'), false);
    assert.deepEqual(store.activeRoster(period.end).employees.map(row => row.employeeCode), ['A001', 'A002', 'A003']);
    assert.equal(store.activeRoster(period.end).employees.find(row => row.employeeCode === 'A002').lifecycleStatus, 'unknown');
    assert.deepEqual(store.activeTimecards(period.end).rows.map(row => row.employeeCode), ['A001', 'A002', 'A003']);
    assert.equal(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).rows.length, 3);
    assert.equal(store.auditTimecards(period.end).verified, true);
    assert.equal(store.auditResourceLinks(TIMECARD_SUMMARY, period.end).verified, true);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications WHERE kind=? AND target=?').get('roster', period.end).count, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications WHERE kind=? AND target=?').get('timecards', period.end).count, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM resource_link_publications WHERE resource_type=? AND target=?')
      .get(TIMECARD_SUMMARY, period.end).count, 2);
    const replayed = store.publishWorkforceSync(publishInput);
    assert.equal(replayed.disposition, 'published');
    assert.deepEqual(replayed.counts, result.counts);
    assert.deepEqual(replayed.delta, result.delta);
    assert.deepEqual(replayed.persistence, result.persistence);
    const changeHistory = store.syncChangeHistory('paycom-main', period.end);
    assert.equal(changeHistory.total, 1);
    assert.equal(changeHistory.items[0].runId, 'atomic-sync-1');
    assert.equal(changeHistory.items[0].businessDate, '2026-08-27');
    assert.equal(changeHistory.items[0].businessTimezone, 'America/Los_Angeles');
    assert.deepEqual(changeHistory.items[0].delta, result.delta);
    assert.equal(replayed.rosterPublicationId, result.rosterPublicationId);
    assert.equal(replayed.timecardPublicationId, result.timecardPublicationId);
    assert.equal(replayed.resourceLinkPublicationId, result.resourceLinkPublicationId);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications WHERE kind=? AND target=?').get('roster', period.end).count, 2);
    const activeIdsBeforeMissing = ['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id);
    const activeRosterBeforeMissing = store.activeRoster(period.end).employees;
    const activeTimecardsBeforeMissing = store.activeTimecards(period.end).rows;
    const missingOnlySource = activeRosterBeforeMissing.filter(row => row.employeeCode !== 'A002');
    const missingOnlyCollected = activeTimecardsBeforeMissing.filter(row => row.employeeCode !== 'A002');
    const missingOnlyPlan = planWorkforceMirror({
      period,
      priorRosterRows: activeRosterBeforeMissing,
      priorTimecardRows: activeTimecardsBeforeMissing,
      sourceEmployees: missingOnlySource,
      collectedTimecardRows: missingOnlyCollected,
    });
    assert.equal(missingOnlyPlan.hasChanges, false);
    const missingOperationInput = {
      runId: 'atomic-missing-preview', attempt: 1, collectedAt: '2026-08-27T06:10:00.000Z',
      businessTimezone: 'America/Los_Angeles', period, sourceSha256: '5'.repeat(64), sourceFormat: 'paycom-employees-json.v1',
      sourceEmployees: missingOnlySource, mirrorPlan: missingOnlyPlan, stagingRoot: staging,
      base: activeWorkforceBase(store, period.end),
      observation: {
        sourceId: 'paycom-main', target: period.end, runId: 'atomic-missing-preview',
        observedAt: '2026-08-27T06:10:00.000Z', sourceSha256: '5'.repeat(64),
        employees: missingOnlySource,
        timecardRows: missingOnlyCollected,
        reconcileBatchSize: 2, fullReconcileMinutes: 1440,
      },
    };
    const missingPreview = store.previewWorkforceSync(missingOperationInput);
    assert.equal(missingPreview.disposition, 'no_change');
    assert.equal(missingPreview.wouldPublish, false);
    assert.equal(missingPreview.counts.retainedMissingCount, 1);
    assert.deepEqual(['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id), activeIdsBeforeMissing);
    const missingOnly = store.publishWorkforceSync({
      ...missingOperationInput,
      runId: 'atomic-missing-only',
      observation: { ...missingOperationInput.observation, runId: 'atomic-missing-only' },
    });
    assert.equal(missingOnly.disposition, 'no_change');
    assert.equal(missingOnly.counts.retainedMissingCount, 1);
    assert.equal(missingOnly.persistence.verified, true);
    assert.equal(missingOnly.persistence.selectedTimecardCount, missingOnlyCollected.length);
    assert.equal(missingOnly.persistence.persistedSelectedTimecardCount, missingOnlyCollected.length);
    assert.equal(missingOnly.persistence.selectedMismatchCount, 0);
    assert.equal(missingOnly.delta.timecards.changedCount, 0);
    assert.equal(missingOnly.delta.timecards.unchangedCount, 3);
    assert.equal(missingOnly.delta.punches.addedCount, 0);
    assert.equal(store.syncChangeHistory('paycom-main', period.end).total, 2);
    assert.deepEqual(['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id), activeIdsBeforeMissing);

    const beforeReturnRoster = store.activeRoster(period.end).employees;
    const beforeReturnTimecards = store.activeTimecards(period.end).rows;
    const returnedSource = beforeReturnRoster.map(row => row.employeeCode === 'A002'
      ? { ...row, status: 'A', lifecycleStatus: 'active', isActive: true, isActiveDriver: true }
      : row);
    const returnedSelection = store.planWorkforceShadow({
      sourceId: 'paycom-main', target: period.end, observedAt: '2026-08-27T06:10:30.000Z',
      employees: returnedSource, reconcileBatchSize: 2, fullReconcileMinutes: 1440,
    });
    const returnedCards = beforeReturnTimecards.filter(row => returnedSelection.selectedEmployees
      .some(employeeRow => employeeRow.employeeCode === row.employeeCode));
    const returnPlan = planWorkforceMirror({
      period,
      priorRosterRows: beforeReturnRoster,
      priorTimecardRows: beforeReturnTimecards,
      sourceEmployees: returnedSource,
      collectedTimecardRows: returnedCards,
    });
    assert.equal(returnPlan.counts.returnedFromUnknownCount, 1);
    assert.equal(returnPlan.counts.unknownEmployeeCount, 0);
    const returned = store.publishWorkforceSync({
      runId: 'atomic-return-unknown', attempt: 1, collectedAt: '2026-08-27T06:10:30.000Z',
      businessTimezone: 'America/Los_Angeles', period, sourceSha256: '8'.repeat(64), sourceFormat: 'paycom-employees-json.v1',
      sourceEmployees: returnedSource, mirrorPlan: returnPlan, stagingRoot: staging,
      base: activeWorkforceBase(store, period.end),
      observation: {
        sourceId: 'paycom-main', target: period.end, runId: 'atomic-return-unknown',
        observedAt: '2026-08-27T06:10:30.000Z', sourceSha256: '8'.repeat(64),
        employees: returnedSource,
        timecardRows: returnedCards,
        reconcileBatchSize: 2, fullReconcileMinutes: 1440,
      },
    });
    assert.equal(returned.disposition, 'published');
    assert.equal(store.activeRoster(period.end).employees.find(row => row.employeeCode === 'A002').lifecycleStatus, 'active');

    const beforeDeactivationRoster = store.activeRoster(period.end).employees;
    const beforeDeactivationTimecards = store.activeTimecards(period.end).rows;
    const deactivatedSource = beforeDeactivationRoster.map(row => row.employeeCode === 'A002'
      ? { ...row, status: 'I', lifecycleStatus: 'inactive', isActive: false, isActiveDriver: false }
      : row);
    const deactivationCards = beforeDeactivationTimecards.filter(row => row.employeeCode !== 'A002');
    const deactivationPlan = planWorkforceMirror({
      period,
      priorRosterRows: beforeDeactivationRoster,
      priorTimecardRows: beforeDeactivationTimecards,
      sourceEmployees: deactivatedSource,
      collectedTimecardRows: deactivationCards,
    });
    assert.equal(deactivationPlan.counts.deactivatedCount, 1);
    assert.equal(deactivationPlan.counts.reactivatedCount, 0);
    assert.equal(deactivationPlan.counts.activeEmployeeCount, 2);
    const deactivated = store.publishWorkforceSync({
      runId: 'atomic-deactivate', attempt: 1, collectedAt: '2026-08-27T06:11:00.000Z',
      businessTimezone: 'America/Los_Angeles', period, sourceSha256: '6'.repeat(64), sourceFormat: 'paycom-employees-json.v1',
      sourceEmployees: deactivatedSource, mirrorPlan: deactivationPlan, stagingRoot: staging,
      base: activeWorkforceBase(store, period.end),
      observation: {
        sourceId: 'paycom-main', target: period.end, runId: 'atomic-deactivate',
        observedAt: '2026-08-27T06:11:00.000Z', sourceSha256: '6'.repeat(64),
        employees: deactivatedSource,
        timecardRows: deactivationCards,
        reconcileBatchSize: 2, fullReconcileMinutes: 1440,
      },
    });
    assert.equal(deactivated.disposition, 'published');
    assert.equal(store.activeRoster(period.end).employees.find(row => row.employeeCode === 'A002').isActive, false);
    assert.deepEqual(store.activeTimecards(period.end).rows.map(row => row.employeeCode), ['A001', 'A003']);
    assert.deepEqual(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).rows.map(row => row.employeeCode), ['A001', 'A003']);
    assert.equal(store.auditTimecards(period.end).activeEmployees, 2);

    const beforeReactivationRoster = store.activeRoster(period.end).employees;
    const beforeReactivationTimecards = store.activeTimecards(period.end).rows;
    const reactivatedSource = beforeReactivationRoster.map(row => row.employeeCode === 'A002'
      ? { ...row, status: 'A', lifecycleStatus: 'active', isActive: true, isActiveDriver: true }
      : row);
    const reactivationCards = [...beforeReactivationTimecards, shadowTimecardRow(
      'A002', period.end, {}, '2026-08-27T06:12:00.000Z',
    )].sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
    const reactivationPlan = planWorkforceMirror({
      period,
      priorRosterRows: beforeReactivationRoster,
      priorTimecardRows: beforeReactivationTimecards,
      sourceEmployees: reactivatedSource,
      collectedTimecardRows: reactivationCards,
    });
    assert.equal(reactivationPlan.counts.deactivatedCount, 0);
    assert.equal(reactivationPlan.counts.reactivatedCount, 1);
    assert.equal(reactivationPlan.counts.activeEmployeeCount, 3);
    const reactivated = store.publishWorkforceSync({
      runId: 'atomic-reactivate', attempt: 1, collectedAt: '2026-08-27T06:12:00.000Z',
      businessTimezone: 'America/Los_Angeles', period, sourceSha256: '7'.repeat(64), sourceFormat: 'paycom-employees-json.v1',
      sourceEmployees: reactivatedSource, mirrorPlan: reactivationPlan, stagingRoot: staging,
      base: activeWorkforceBase(store, period.end),
      observation: {
        sourceId: 'paycom-main', target: period.end, runId: 'atomic-reactivate',
        observedAt: '2026-08-27T06:12:00.000Z', sourceSha256: '7'.repeat(64),
        employees: reactivatedSource,
        timecardRows: reactivationCards,
        reconcileBatchSize: 2, fullReconcileMinutes: 1440,
      },
    });
    assert.equal(reactivated.disposition, 'published');
    assert.equal(store.activeRoster(period.end).employees.find(row => row.employeeCode === 'A002').isActive, true);
    assert.deepEqual(store.activeTimecards(period.end).rows.map(row => row.employeeCode), ['A001', 'A002', 'A003']);
    assert.equal(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).rows.length, 3);
    assert.equal(store.auditTimecards(period.end).activeEmployees, 3);

    const capturedBase = activeWorkforceBase(store, period.end);
    const priorRosterPublication = store.db.prepare(`SELECT id FROM publications
      WHERE kind='roster' AND target=? AND id<>?`).get(period.end, capturedBase.rosterPublicationId);
    store.db.prepare(`UPDATE active_publications SET publication_id=?
      WHERE kind='roster' AND target=?`).run(priorRosterPublication.id, period.end);
    try {
      assert.throws(() => store.previewWorkforceSync({
        ...publishInput,
        runId: 'atomic-preview-stale-base',
        base: capturedBase,
        observation: { ...publishInput.observation, runId: 'atomic-preview-stale-base' },
      }), /publication_base_changed/);
      assert.throws(() => store.publishWorkforceSync({
        ...publishInput,
        runId: 'atomic-stale-base',
        base: capturedBase,
        observation: { ...publishInput.observation, runId: 'atomic-stale-base' },
      }), /publication_base_changed/);
    } finally {
      store.db.prepare(`UPDATE active_publications SET publication_id=?
        WHERE kind='roster' AND target=?`).run(capturedBase.rosterPublicationId, period.end);
    }
    assert.equal(store.shadowReceiptForRun('paycom-main', period.end, 'atomic-preview-stale-base'), null);
    assert.equal(store.shadowReceiptForRun('paycom-main', period.end, 'atomic-stale-base'), null);
    const activeBeforeFailure = ['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id);

    const badSource = [employee('A001', { positionTitle: 'Manager', totalHours: '10' }), employee('A003')];
    const badCollected = [shadowTimecardRow('A001', period.end, { attestations: [['changed']] }, '2026-08-27T06:15:00.000Z')];
    const badPlan = planWorkforceMirror({
      period,
      priorRosterRows: store.activeRoster(period.end).employees,
      priorTimecardRows: store.activeTimecards(period.end).rows,
      sourceEmployees: badSource,
      collectedTimecardRows: badCollected,
    });
    badPlan.resourceLinkRows[0] = { ...badPlan.resourceLinkRows[0], canonicalUrl: 'https://invalid.example/' };
    assert.throws(() => store.publishWorkforceSync({
      runId: 'atomic-sync-fail', attempt: 1, collectedAt: '2026-08-27T06:15:00.000Z',
      businessTimezone: 'America/Los_Angeles', period, sourceSha256: '4'.repeat(64), sourceFormat: 'paycom-employees-json.v1',
      sourceEmployees: badSource, mirrorPlan: badPlan, stagingRoot: staging,
      base: activeWorkforceBase(store, period.end),
      observation: {
        sourceId: 'paycom-main', target: period.end, runId: 'atomic-sync-fail',
        observedAt: '2026-08-27T06:15:00.000Z', sourceSha256: '4'.repeat(64),
        employees: badSource,
        timecardRows: badCollected,
        reconcileBatchSize: 2, fullReconcileMinutes: 1440,
      },
    }), /candidate_invalid/);
    const activeAfterFailure = ['roster', 'timecards'].map(kind => store.active(kind, period.end).id)
      .concat(store.activeResourceLinks(TIMECARD_SUMMARY, period.end).publication.id);
    assert.deepEqual(activeAfterFailure, activeBeforeFailure);
    assert.equal(store.shadowReceiptForRun('paycom-main', period.end, 'atomic-sync-fail'), null);
    assert.deepEqual(fs.readdirSync(staging), []);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync.current-workforce records a private shadow baseline without publishing Paycom data', async () => {
  const { root, database } = fixture();
  const bytes = rosterBytes([rawEmployee('A001'), rawEmployee('A002')]);
  const captured = {
    bytes,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    completeness: { observable: true, authoritative: true, requestedCount: 2, returnedCount: 2 },
  };
  let browserRuns = 0;
  const browserRunner = async (request, callback) => {
    browserRuns += 1;
    return callback({ endpoint: 'fixture' });
  };
  const timecardCollector = async (endpoint, employees, period) => ({
    rows: employees.map(item => shadowTimecardRow(item.employeeCode, period.end)),
    performance: fixturePerformance(employees.length),
  });
  try {
    const receipt = await execute(syncRequest(), {
      database,
      browserRunner,
      rosterCollector: async () => captured,
      timecardCollector,
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.status, 'no_change');
    assert.equal(receipt.data.mode, 'shadow');
    assert.equal(receipt.data.baseline, true);
    assert.equal(receipt.data.observedCount, 2);
    assert.equal(receipt.data.selectedTimecardCount, 2);
    assert.equal(receipt.data.timecardBaselineCount, 2);
    assert.equal(receipt.data.fullReconciliation, false);
    assert.equal(browserRuns, 1);
    assert.equal(JSON.stringify(receipt).includes('A001'), false);
    assert.doesNotThrow(() => boundedJson(receipt));
    const store = new PaycomStore(database);
    try {
      assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications').get().count, 0);
      assert.equal(store.syncState('paycom-main', receipt.data.target).employeeCount, 2);
    } finally { store.close(); }
    const replay = await execute(syncRequest(), {
      database, browserRunner, rosterCollector: async () => captured, timecardCollector,
    });
    assert.equal(replay.data.replayed, true);
    assert.equal(browserRuns, 1);
    await assert.rejects(() => execute(syncRequest('shadow-2'), {
      database,
      browserRunner,
      rosterCollector: async () => ({
        ...captured,
        completeness: {
          ...captured.completeness, observable: false, authoritative: false,
          authorityCode: 'roster_filter_search',
        },
      }),
    }), /roster_filter_search/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync.current-workforce rejects a source business-date rollover before persistence', async () => {
  const { root, database } = fixture();
  const bytes = rosterBytes([rawEmployee('A001')]);
  const captured = {
    bytes,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    completeness: { observable: true, authoritative: true, requestedCount: 1, returnedCount: 1 },
  };
  const times = [new Date('2026-08-31T06:59:00.000Z'), new Date('2026-08-31T07:01:00.000Z')];
  try {
    await assert.rejects(() => execute(syncRequest('date-rollover'), {
      database,
      businessClock: () => times.shift(),
      browserRunner: async (request, callback) => callback({ endpoint: 'fixture' }),
      rosterCollector: async () => captured,
      timecardCollector: async (endpoint, employees, period) => ({
        rows: employees.map(item => shadowTimecardRow(item.employeeCode, period.end)),
        performance: fixturePerformance(employees.length),
      }),
    }), /business_date_changed/);
    const store = new PaycomStore(database);
    try { assert.equal(store.syncState('paycom-main', '2026-09-05'), null); }
    finally { store.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync.current-workforce enforces the requested period even when the UI defaults to another period', async () => {
  const { root, database } = fixture();
  const bytes = rosterBytes([rawEmployee('A001')]);
  const captured = {
    bytes,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    completeness: { observable: true, authoritative: true, requestedCount: 1, returnedCount: 1 },
    uiPeriod: { start: '2026-08-09', end: '2026-08-22' },
  };
  try {
    const receipt = await execute(syncRequest('period-rewrite'), {
      database,
      businessClock: () => new Date('2026-08-30T18:00:00.000Z'),
      browserRunner: async (request, callback) => callback({ endpoint: 'fixture' }),
      rosterCollector: async () => captured,
      timecardCollector: async (endpoint, employees, period) => ({
        rows: employees.map(item => shadowTimecardRow(item.employeeCode, period.end)),
        performance: fixturePerformance(employees.length),
      }),
    });
    assert.equal(receipt.status, 'no_change');
    assert.equal(receipt.data.target, '2026-09-05');
    assert.equal(receipt.data.performance.requestedPeriodEnforced, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first publishing sync rejects an incomplete source without recording success', async () => {
  const { root, database } = fixture();
  const bytes = rosterBytes([rawEmployee('A001')]);
  const request = syncRequest('incomplete-baseline');
  request.input.publishMode = 'additions_edits';
  try {
    await assert.rejects(execute(request, {
      database,
      browserRunner: async (value, callback) => callback({ endpoint: 'fixture' }),
      rosterCollector: async () => ({ bytes, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        completeness: { observable: true, authoritative: false, returnedCount: 1 } }),
      timecardCollector: async () => assert.fail('Do not collect an incomplete baseline'),
    }), /roster_source_not_authoritative/);
    const store = new PaycomStore(database);
    try { assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications').get().count, 0); }
    finally { store.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('first sync publishes a complete baseline atomically, replays, and starts a new pay period', async () => {
  const { root, database, staging } = fixture();
  const bytes = rosterBytes([rawEmployee('A001'), rawEmployee('A002')]);
  let clock = new Date('2026-08-30T18:00:00.000Z');
  let failCollection = true;
  let corruptRow = false;
  let browserRuns = 0;
  const dependencies = {
    database, stagingRoot: staging, businessClock: () => clock,
    browserRunner: async (value, callback) => { browserRuns++; return callback({ endpoint: 'fixture' }); },
    rosterCollector: async () => ({ bytes, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      completeness: { observable: true, authoritative: true, returnedCount: 2 } }),
    timecardCollector: async (endpoint, employees, period) => {
      assert.equal(employees.length, 2, 'Initial import exceeds the rotating batch of one');
      return { rows: employees.slice(0, failCollection ? 1 : 2).map(item => ({ ...shadowTimecardRow(item.employeeCode, period.end, {}, clock.toISOString()),
          ...(corruptRow ? { businessSha256: 'b'.repeat(64) } : {}) })),
        performance: fixturePerformance(employees.length) };
    },
  };
  const request = syncRequest('complete-baseline');
  request.input.publishMode = 'additions_edits';
  request.input.reconcileBatchSize = 1;
  try {
    await assert.rejects(execute(request, dependencies), /membership_mismatch/);
    let store = new PaycomStore(database);
    assert.equal(Boolean(store.active('roster', '2026-09-05')), false);
    store.close();
    failCollection = false;
    corruptRow = true;
    await assert.rejects(execute(request, dependencies), /timecards_invalid|candidate_invalid/);
    store = new PaycomStore(database);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publications').get().count, 0, 'Roll back periods and roster when timecard validation fails');
    store.close();
    corruptRow = false;
    const first = await execute(request, dependencies);
    assert.equal(first.data.publicationStatus, 'ready');
    assert.equal(first.data.persistence.verified, true);
    assert.deepEqual(fs.readdirSync(staging), []);
    const interrupted = path.join(staging, `${request.runId}.attempt-1`);
    fs.mkdirSync(interrupted, { mode: 0o700 });
    fs.writeFileSync(path.join(interrupted, '.candidate.tmp'), 'interrupted fixture', { mode: 0o600 });
    const replay = await execute(request, dependencies);
    assert.equal(replay.data.replayed, true);
    assert.deepEqual(fs.readdirSync(staging), [], 'Committed replay still removes interrupted staging');
    assert.equal(browserRuns, 3);
    clock = new Date('2026-09-08T18:00:00.000Z');
    const next = await execute({ ...request, runId: 'period-rollover' }, dependencies);
    assert.equal(next.data.target, '2026-09-19');
    assert.equal(next.data.publicationStatus, 'ready');
    store = new PaycomStore(database);
    try {
      for (const target of ['2026-09-05', '2026-09-19']) {
        assert.equal(store.activeRoster(target).employees.length, 2);
        assert.equal(store.auditTimecards(target).verified, true);
        assert.equal(store.auditResourceLinks(TIMECARD_SUMMARY, target).verified, true);
      }
    } finally { store.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
