'use strict';
const { rosterRow, timecardRecord } = require('./helpers');
const { periodFromEnd } = require('../src/timecard-period');
const { linkRows, TIMECARD_SUMMARY } = require('../src/resource-links');
function workforceFixture({ name = 'Fixture', count = 3, target = '2026-09-19' } = {}) {
  const period = periodFromEnd(target), collected = '2026-09-11T12:00:00.000Z';
  const employees = Array.from({ length: count }, (_, index) => rosterRow(index.toString(36).toUpperCase().padStart(4, '0'), `${name} Employee ${index + 1}`));
  const publication = { id: `roster-${name}-${target}`, target, collected_at: collected, content_sha256: 'a'.repeat(64) };
  return { roster: { publication, employees },
    timecards: { publication: { id: `timecards-${name}-${target}`, target, collected_at: collected },
      rows: employees.map(row => ({ ...row, observedAt: collected, record: timecardRecord(row.employeeCode, target) })) },
    resourceLinks: { publication: { id: `links-${name}-${target}`, target, collected_at: collected,
      period_key: period.key, resource_type: TIMECARD_SUMMARY }, rows: linkRows(TIMECARD_SUMMARY, employees, period) } };
}
module.exports = { workforceFixture };
