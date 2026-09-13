'use strict';
const { PaycomStore } = require('./store');
const { TIMECARD_SUMMARY } = require('./resource-links');
const { publicationBaseline, createPublicationBaseline } = require('dispatch-protocol/contracts/src/publication-baseline');
function fail() { throw Object.assign(new Error('first_publication_failed'), { code: 'first_publication_failed' }); }
function verifyPublicationContinuity(database, input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || !['capture', 'verify'].includes(input.mode)
      || Object.keys(input).sort().join(',') !== (input.mode === 'capture' ? 'mode' : 'baseline,mode')) fail();
  const expected = input.mode === 'verify' ? publicationBaseline(input.baseline) : null;
  const store = new PaycomStore(database, { readOnly: true });
  try {
    store.db.exec('BEGIN');
    const periods = store.active('pay_periods');
    const current = periods && store.db.prepare("SELECT period_end FROM pay_periods WHERE publication_id=? AND relation='current'").all(periods.id);
    if (current?.length !== 1) fail();
    const target = current[0].period_end;
    const values = {
      payPeriods: [periods, store.auditPayPeriodTarget(target)],
      roster: [store.active('roster', target), store.audit('roster', target)],
      timecards: [store.active('timecards', target), store.audit('timecards', target)],
      resourceLinks: [store.activeResourceLinks(TIMECARD_SUMMARY, target)?.publication,
        store.auditResourceLinks(TIMECARD_SUMMARY, target)],
    };
    const publications = {};
    for (const [name, [publication, audit]] of Object.entries(values)) {
      if (!publication || !audit.verified || audit.contentSha256 !== publication.content_sha256) fail();
      publications[name] = { id: publication.id, originRunId: publication.run_id, contentSha256: publication.content_sha256 };
    }
    if (!store.auditTimecards(target).verified) fail();
    const baseline = createPublicationBaseline(target, publications);
    if (expected && expected.digest !== baseline.digest) fail();
    store.db.exec('COMMIT');
    return expected ? Object.freeze({ status: 'verified', publicationBaselineDigest: baseline.digest })
      : Object.freeze({ status: 'verified', publicationBaseline: baseline });
  } finally { store.close(); }
}
module.exports = { verifyPublicationContinuity };
