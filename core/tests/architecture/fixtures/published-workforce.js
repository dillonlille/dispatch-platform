'use strict';
const path = require('node:path');
const { privateDirectory } = require('../../../host/controller/operations');
const { PaycomStore, stageCandidate, cleanupStage } = require('dispatch-dsp/plugins/paycom/backend/src/store.js');
const { periodFromEnd } = require('dispatch-dsp/plugins/paycom/backend/src/timecard-period.js');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('dispatch-dsp/plugins/paycom/backend/src/resource-links.js');
const { rosterRow, timecardRecord } = require('dispatch-dsp/plugins/paycom/backend/tests/helpers.js');
function seed(dspRoot, end) {
  const database = path.join(privateDirectory(path.join(dspRoot, 'data/db/paycom')), 'paycom.sqlite3');
  const staging = privateDirectory(path.join(dspRoot, 'staging/plugins/paycom'));
  const store = new PaycomStore(database), period = periodFromEnd(end), rows = [rosterRow('A001', 'Synthetic Employee')];
  const publish = candidate => {
    const staged = stageCandidate(staging, { target: end, attempt: 1, collectedAt: '2026-09-04T12:00:00.000Z',
      runId: `run_${candidate.kind}_${end}`, ...candidate });
    try { return store.publish(staged); } finally { cleanupStage(staged, staging); }
  };
  try {
    const roster = publish({ kind: 'roster', metadata: {}, rows });
    const common = { periodStart: period.start, periodEnd: end, rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256 };
    publish({ kind: 'timecards', periodKey: period.key, metadata: { ...common, mode: 'full' }, rows: rows.map(row => ({
      employeeCode: row.employeeCode, employeeName: row.employeeName, record: timecardRecord(row.employeeCode, end), sourceSha256: 'b'.repeat(64) })) });
    publish({ kind: 'resource_links', periodKey: period.key, metadata: { ...common, resourceType: TIMECARD_SUMMARY, routeVersion: ROUTE_VERSION },
      rows: linkRows(TIMECARD_SUMMARY, rows, period) });
  } finally { store.close(); }
}
module.exports = { seed };
