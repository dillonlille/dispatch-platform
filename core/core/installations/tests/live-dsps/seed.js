#!/usr/local/bin/node
'use strict';
// Invoked only by the root-owned live-test runner in its own recorded DSP namespace.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PaycomStore, stageCandidate, cleanupStage } = require('/opt/dispatch/plugins/paycom/backend/src/store');
const { DATABASE, STAGING_ROOT } = require('/opt/dispatch/plugins/paycom/backend/src/paths');
const { periodFromEnd } = require('/opt/dispatch/plugins/paycom/backend/src/timecard-period');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('/opt/dispatch/plugins/paycom/backend/src/resource-links');
const { timecardRecord, rosterRow } = require('/run/dispatch-test-tools/helpers');
const PAYCOM_SYNC_ID = 'paycom-main-workforce';
process.umask(0o077);
const store = new PaycomStore(DATABASE);
const changed = process.argv[2] === '--changed';
const period = periodFromEnd(changed ? '2026-09-19' : '2026-09-05');
const collectedAt = new Date().toISOString();
function publish(candidate) {
  const stage = stageCandidate(STAGING_ROOT, { attempt: 1, collectedAt, ...candidate, runId: candidate.runId + (changed ? '_changed' : '') });
  try { return store.publish(stage); } finally { cleanupStage(stage, STAGING_ROOT); }
}
const payPeriods = publish({ kind: 'pay_periods', target: period.end, runId: 'run_periods_fixture', metadata: {},
  rows: [{ start: period.start, end: period.end, key: period.key, relation: 'current' }] });
const rows = [rosterRow('Z999', changed ? 'Synthetic Updated Employee' : 'Synthetic Fixture Employee')];
const roster = publish({ kind: 'roster', target: period.end, runId: 'run_fixture_roster', metadata: {}, rows });
const timecards = publish({ kind: 'timecards', target: period.end, periodKey: period.key,
  runId: 'run_fixture_timecards', metadata: { periodStart: period.start, periodEnd: period.end, mode: 'full',
    rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256 },
  rows: [{ employeeCode: rows[0].employeeCode, employeeName: rows[0].employeeName,
    record: timecardRecord(rows[0].employeeCode, period.end), sourceSha256: 'b'.repeat(64) }] });
const links = publish({ kind: 'resource_links', target: period.end, periodKey: period.key,
  runId: 'run_fixture_links', metadata: { resourceType: TIMECARD_SUMMARY, periodStart: period.start,
    periodEnd: period.end, rosterPublicationId: roster.publicationId, rosterContentSha256: roster.contentSha256,
    routeVersion: ROUTE_VERSION }, rows: linkRows(TIMECARD_SUMMARY, rows, period) });
store.close();
if (!changed) {
  const { CollectionStore } = require('/opt/dispatch/runtime/collection-manager/src/store');
  const { defaultPaths } = require('/opt/dispatch/runtime/collection-manager/src/paths');
  const { materializeSpec } = require('/opt/dispatch/runtime/collection-manager/src/control-cli');
  const spec = JSON.parse(fs.readFileSync('/opt/dispatch/plugins/paycom/backend/config/collection-manager.json'));
  for (const sync of spec.syncs || []) sync.desiredState = 'stopped';
  for (const plan of spec.plans) plan.schedule = { type: 'manual' };
  const collection = new CollectionStore(defaultPaths());
  try { collection.applySpec(materializeSpec(spec, '/opt/dispatch')); } finally { collection.close(); }
}
process.stdout.write(`${JSON.stringify({ payPeriods, roster, timecards, links })}\n`);
