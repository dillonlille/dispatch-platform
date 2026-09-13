'use strict';

const crypto = require('node:crypto');
const { PaycomStore } = require('./store');
const { TIMECARD_SUMMARY } = require('./resource-links');

const HASH_RE = /^[a-f0-9]{64}$/;
const SOURCE_ID = 'paycom-main';
const EXPECTED_REQUEST = Object.freeze({
  source: SOURCE_ID,
  scope: 'full',
  selector: Object.freeze({ kind: 'current' }),
  mode: 'refresh',
});
const EXPECTED_TASKS = Object.freeze({
  'paycom-period-roster': Object.freeze({ taskId: 'roster', method: 'roster.period', publication: 'roster' }),
  'paycom-period-timecards-from-roster': Object.freeze({
    taskId: 'timecards', method: 'timecards.from-published-roster', publication: 'timecards',
  }),
  'paycom-period-timecards-audit': Object.freeze({ taskId: 'timecards-audit', method: 'timecards.audit' }),
  'paycom-period-resource-links': Object.freeze({
    taskId: 'links', method: 'resource-links.period', publication: 'resourceLinks',
  }),
  'paycom-period-resource-links-audit': Object.freeze({ taskId: 'links-audit', method: 'resource-links.audit' }),
});

function fail(code = 'first_publication_failed') {
  throw Object.assign(new Error(code), { code });
}
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function publicationRecord(publication, runId) {
  if (!publication || typeof publication.id !== 'string' || typeof publication.run_id !== 'string'
      || typeof publication.content_sha256 !== 'string' || !HASH_RE.test(publication.content_sha256)) fail();
  return Object.freeze({
    id: publication.id,
    runId,
    originRunId: publication.run_id,
    contentSha256: publication.content_sha256,
    batchBound: true,
  });
}

function verifyActivationEvidence(options) {
  if (!plain(options) || Object.keys(options).sort().join(',')
      !== 'batchId,clock,definitionDigest,manager,paycomDatabase,preparationRunId'
      || typeof options.manager?.batch !== 'function' || typeof options.manager?.run !== 'function' || typeof options.paycomDatabase !== 'string'
      || typeof options.clock !== 'function' || typeof options.batchId !== 'string'
      || typeof options.preparationRunId !== 'string'
      || typeof options.definitionDigest !== 'string' || !HASH_RE.test(options.definitionDigest)) {
    fail('runtime_boundary_violation');
  }
  const { batchId, definitionDigest, preparationRunId } = options;
  let manager;
  let paycom;
  try {
    manager = options.manager;
    paycom = new PaycomStore(options.paycomDatabase, { readOnly: true });
    const batch = manager.batch(batchId);
    if (batch.status !== 'succeeded' || batch.source !== SOURCE_ID || batch.scope !== 'full'
        || !same(batch.request, EXPECTED_REQUEST) || typeof batch.previewHash !== 'string'
        || !HASH_RE.test(batch.previewHash) || batch.runs.length !== Object.keys(EXPECTED_TASKS).length) fail();
    const selectedRuns = [];
    let target = null;
    const byPublication = {};
    const auditRuns = {};
    for (const item of batch.runs) {
      const expected = EXPECTED_TASKS[item.run.plan];
      const run = manager.run(item.run.id);
      const runTarget = expected?.publication ? run.receipt?.data?.target
        : run.receipt?.data?.audit?.periodEnd || run.receipt?.data?.audit?.target;
      if (!expected || item.taskId !== expected.taskId || item.targetKey !== runTarget
          || run.status !== 'succeeded' || run.source !== SOURCE_ID || run.plan !== item.run.plan
          || run.method !== expected.method || run.receipt?.ok !== true
          || run.receipt.data?.method !== expected.method) fail();
      if (target === null) target = item.targetKey;
      if (item.targetKey !== target) fail();
      selectedRuns.push(Object.freeze({
        id: run.id,
        taskId: item.taskId,
        plan: run.plan,
        method: run.method,
      }));
      if (expected.publication) {
        const receipt = run.receipt.data;
        if (typeof receipt.publicationId !== 'string' || typeof receipt.contentSha256 !== 'string'
            || !HASH_RE.test(receipt.contentSha256)
            || !['published', 'no_change', 'reactivated'].includes(receipt.disposition)) fail();
        byPublication[expected.publication] = { run, receipt };
      } else {
        const audit = run.receipt.data.audit;
        if (!plain(audit) || audit.verified !== true) fail();
        auditRuns[run.method] = audit;
      }
    }
    if (typeof target !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(target)
        || Object.keys(byPublication).sort().join(',') !== 'resourceLinks,roster,timecards'
        || Object.keys(auditRuns).sort().join(',') !== 'resource-links.audit,timecards.audit') fail();

    const roster = paycom.active('roster', target);
    const timecards = paycom.active('timecards', target);
    const resourceLinks = paycom.activeResourceLinks(TIMECARD_SUMMARY, target)?.publication;
    const rosterAudit = roster && paycom.auditPublication(roster.id);
    const timecardAudit = paycom.auditTimecards(target);
    const resourceLinkAudit = paycom.auditResourceLinks(TIMECARD_SUMMARY, target);
    const payPeriodAudit = paycom.auditPayPeriodTarget(target);
    const preparationRun = manager.run(preparationRunId);
    if (!rosterAudit?.verified || !timecardAudit?.verified || !resourceLinkAudit?.verified
        || !payPeriodAudit?.verified
        || preparationRun.status !== 'succeeded' || preparationRun.plan !== 'paycom-periods'
        || preparationRun.source !== SOURCE_ID || preparationRun.method !== 'pay-periods.discover'
        || preparationRun.receipt?.ok !== true
        || preparationRun.receipt.data?.method !== 'pay-periods.discover'
        || !['published', 'no_change', 'reactivated'].includes(preparationRun.receipt.data?.disposition)
        || preparationRun.receipt.data?.publicationId !== payPeriodAudit.publicationId
        || preparationRun.receipt.data?.contentSha256 !== payPeriodAudit.contentSha256
        || byPublication.roster.receipt.publicationId !== roster.id
        || byPublication.roster.receipt.contentSha256 !== roster.content_sha256
        || byPublication.timecards.receipt.publicationId !== timecards.id
        || byPublication.timecards.receipt.contentSha256 !== timecards.content_sha256
        || byPublication.resourceLinks.receipt.publicationId !== resourceLinks.id
        || byPublication.resourceLinks.receipt.contentSha256 !== resourceLinks.content_sha256
        || auditRuns['timecards.audit'].rosterPublicationId !== roster.id
        || auditRuns['timecards.audit'].timecardPublicationId !== timecards.id
        || auditRuns['resource-links.audit'].publicationId !== resourceLinks.id
        || auditRuns['resource-links.audit'].rosterPublicationId !== roster.id) fail();

    const captured = options.clock();
    if (!Number.isSafeInteger(captured) || captured < 0) fail('runtime_boundary_violation');
    return Object.freeze({
      definitionDigest,
      requestDigest: digest(EXPECTED_REQUEST),
      previewDigest: batch.previewHash,
      batchId: batch.id,
      preparationRunId,
      target,
      runs: Object.freeze(selectedRuns.sort((left, right) => left.plan.localeCompare(right.plan))),
      publications: Object.freeze({
        payPeriods: Object.freeze({
          id: payPeriodAudit.publicationId,
          runId: preparationRunId,
          originRunId: payPeriodAudit.runId,
          contentSha256: payPeriodAudit.contentSha256,
          batchBound: false,
        }),
        roster: publicationRecord(roster, byPublication.roster.run.id),
        timecards: publicationRecord(timecards, byPublication.timecards.run.id),
        resourceLinks: publicationRecord(resourceLinks, byPublication.resourceLinks.run.id),
      }),
      capturedAt: new Date(captured).toISOString(),
    });
  } catch (error) {
    if (error?.code === 'runtime_boundary_violation') throw error;
    fail();
  } finally {
    try { paycom?.close(); } catch {}
    try { manager?.close(); } catch {}
  }
}

module.exports = {
  EXPECTED_REQUEST,
  EXPECTED_TASKS,
  verifyActivationEvidence,
};
