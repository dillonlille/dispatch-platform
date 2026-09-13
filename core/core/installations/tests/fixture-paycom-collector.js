#!/usr/bin/env node
'use strict';

const path = require('node:path');
const projectRoot = process.env.DISPATCH_PROJECT_ROOT;
if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot) {
  process.exitCode = 1;
  return;
}
const plugin = relative => path.join(projectRoot, 'plugins', 'paycom', 'backend', relative);
const {
  PaycomStore,
  stageCandidate,
  cleanupStage,
} = require(plugin('src/store'));
const { DATABASE, STAGING_ROOT } = require(plugin('src/paths'));
const {
  periodContaining,
  previousPeriod,
  nextPeriod,
  periodFromEnd,
} = require(plugin('src/timecard-period'));
const {
  TIMECARD_SUMMARY,
  ROUTE_VERSION,
  linkRows,
} = require(plugin('src/resource-links'));
const { timecardRecord, rosterRow } = require(plugin('tests/helpers'));

const TODAY = '2026-09-02';
const TARGET = '2026-09-05';
const COLLECTED_AT = '2026-09-02T21:30:00.000Z';

function publish(store, request, candidate) {
  const stage = stageCandidate(STAGING_ROOT, candidate);
  let result;
  try { result = store.publish(stage); }
  finally { cleanupStage(stage, STAGING_ROOT); }
  return {
    ok: true,
    status: result.disposition === 'no_change' ? 'no_change' : 'published',
    data: {
      method: request.method,
      target: candidate.target,
      publicationId: result.publicationId,
      disposition: result.disposition,
      rowCount: result.rowCount,
      contentSha256: result.contentSha256,
    },
  };
}

function execute(request) {
  if (request.method === 'collection.resolve-targets') {
    return {
      ok: true,
      status: 'succeeded',
      data: {
        targetType: 'pay-period',
        targets: [{ key: TARGET, start: '2026-08-23', end: TARGET, values: { periodEnd: TARGET } }],
      },
    };
  }
  const store = new PaycomStore(DATABASE);
  try {
    if (request.method === 'pay-periods.discover') {
      const current = periodContaining(TODAY);
      const rows = [
        { ...previousPeriod(current), relation: 'previous' },
        { ...current, relation: 'current' },
        { ...nextPeriod(current), relation: 'next' },
      ].map(({ start, end, key, relation }) => ({ start, end, key, relation }));
      return publish(store, request, {
        kind: 'pay_periods',
        target: TODAY,
        runId: request.runId,
        attempt: request.attempt,
        collectedAt: COLLECTED_AT,
        metadata: { timezone: request.source.config.timezone, basis: 'fixture' },
        rows,
      });
    }
    const period = periodFromEnd(request.input.periodEnd || TARGET);
    if (request.method === 'roster.period') {
      return publish(store, request, {
        kind: 'roster',
        target: period.end,
        runId: request.runId,
        attempt: request.attempt,
        collectedAt: COLLECTED_AT,
        metadata: { sourceSha256: 'a'.repeat(64) },
        rows: [rosterRow('A001', 'Fixture One'), rosterRow('A002', 'Fixture Two')],
      });
    }
    if (request.method === 'timecards.from-published-roster') {
      const roster = store.activeRoster(period.end);
      const rows = roster.employees.filter(employee => employee.isActive).map((employee, index) => ({
        employeeCode: employee.employeeCode,
        employeeName: employee.employeeName,
        record: timecardRecord(employee.employeeCode, period.end),
        sourceSha256: String(index + 1).repeat(64),
      }));
      return publish(store, request, {
        kind: 'timecards',
        target: period.end,
        periodKey: period.key,
        runId: request.runId,
        attempt: request.attempt,
        collectedAt: COLLECTED_AT,
        metadata: {
          periodStart: period.start,
          periodEnd: period.end,
          mode: 'published_roster',
          rosterPublicationId: roster.publication.id,
          rosterContentSha256: roster.publication.content_sha256,
        },
        rows,
      });
    }
    if (request.method === 'timecards.audit') {
      const audit = store.auditTimecards(period.end);
      if (!audit.verified) return { ok: false, status: 'failed', error: { code: audit.code } };
      return { ok: true, status: 'succeeded', data: { method: request.method, audit } };
    }
    if (request.method === 'resource-links.period') {
      const roster = store.activeRoster(period.end);
      const employees = roster.employees.filter(employee => employee.isActive);
      const receipt = publish(store, request, {
        kind: 'resource_links',
        target: period.end,
        periodKey: period.key,
        runId: request.runId,
        attempt: request.attempt,
        collectedAt: COLLECTED_AT,
        metadata: {
          resourceType: TIMECARD_SUMMARY,
          periodStart: period.start,
          periodEnd: period.end,
          rosterPublicationId: roster.publication.id,
          rosterContentSha256: roster.publication.content_sha256,
          routeVersion: ROUTE_VERSION,
        },
        rows: linkRows(TIMECARD_SUMMARY, employees, period),
      });
      const audit = store.auditResourceLinks(TIMECARD_SUMMARY, period.end);
      if (!audit.verified) throw new Error(audit.code);
      receipt.data.audit = { verified: true, activeEmployees: employees.length, links: audit.rowCount };
      return receipt;
    }
    if (request.method === 'resource-links.audit') {
      const audit = store.auditResourceLinks(TIMECARD_SUMMARY, period.end);
      if (!audit.verified) return { ok: false, status: 'failed', error: { code: audit.code } };
      return { ok: true, status: 'succeeded', data: { method: request.method, audit } };
    }
    throw new Error('invalid_request');
  } finally {
    store.close();
  }
}

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(`${JSON.stringify(execute(request))}\n`);
  } catch (error) {
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(error?.code || error?.message)
      ? error.code || error.message : 'fixture_failed';
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'failed', error: { code } })}\n`);
  }
});
