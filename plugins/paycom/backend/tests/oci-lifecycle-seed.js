#!/usr/local/bin/node
'use strict';
// Installed only in the disposable acceptance image, never the runtime image.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PaycomStore, stageCandidate, cleanupStage } = require('/opt/dispatch/plugins/paycom/backend/src/store');
const { DATABASE, STAGING_ROOT } = require('/opt/dispatch/plugins/paycom/backend/src/paths');
const { periodFromEnd } = require('/opt/dispatch/plugins/paycom/backend/src/timecard-period');
const { TIMECARD_SUMMARY, ROUTE_VERSION, linkRows } = require('/opt/dispatch/plugins/paycom/backend/src/resource-links');
const { timecardRecord, rosterRow } = require('/opt/dispatch/plugins/paycom/backend/tests/helpers');
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
const schema = { type: 'object', properties: { behavior: { type: 'string', enum: ['no_change'] } },
  required: ['behavior'], additionalProperties: false };
const spec = { schemaVersion: 1,
  collectors: [{ id: 'fixture', version: '1.0.0', description: 'Synthetic acceptance collector',
    command: '/opt/dispatch/fixture-collector', sourceSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    methods: { 'fixture.sync': { description: 'No provider access', inputSchema: schema, timeoutSeconds: 5,
      maxAttempts: 1, backoffSeconds: [], concurrencyKeys: ['collector:{collector}'] } } }],
  sources: [{ id: 'fixture-main', collector: 'fixture', authProfile: null, config: {}, enabled: true }],
  plans: [{ id: 'fixture-plan', source: 'fixture-main', method: 'fixture.sync', schedule: { type: 'manual' },
    input: { behavior: 'no_change' }, dependsOn: [], enabled: true }],
  syncs: [{ id: PAYCOM_SYNC_ID, plan: 'fixture-plan', intervalSeconds: 3600, jitterSeconds: 0,
    overlap: 'coalesce', settingsSchema: schema, settings: { behavior: 'no_change' }, desiredState: 'stopped' }] };
const file = path.join(process.env.DISPATCH_RUNTIME_ROOT, 'synthetic-spec.json');
fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
const applied = spawnSync('/usr/local/bin/node', ['/opt/dispatch/runtime/collection-manager/bin/dispatch-collectionctl', 'apply', file],
  { encoding: 'utf8', env: process.env, timeout: 30_000 });
fs.unlinkSync(file);
if (applied.status !== 0 || JSON.parse(applied.stdout).status !== 'applied') throw new Error(`fixture_apply_failed_${JSON.parse(applied.stdout || '{}').status || applied.status}`);
}
process.stdout.write(`${JSON.stringify({ payPeriods, roster, timecards, links })}\n`);
