'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
let calendarDateAt, moveCalendarDate, calendarDateLabel, dateTime, validTimeZone;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/lib/date-time.ts'), 'utf8');
  ({ calendarDateAt, moveCalendarDate, calendarDateLabel, dateTime, validTimeZone } =
    await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`));
});
const { dateInTimezone } = require('dispatch-dsp/plugins/paycom/backend/src/collector.js');
const zone = 'America/Los_Angeles';

test('dashboard and Paycom collector agree before and after Pacific midnight, including DST', () => {
  for (const [instant, expected] of [
    ['2026-09-11T02:28:00Z', '2026-09-10'],
    ['2026-09-11T06:59:59Z', '2026-09-10'], ['2026-09-11T07:00:00Z', '2026-09-11'],
    ['2026-01-11T07:59:59Z', '2026-01-10'], ['2026-01-11T08:00:00Z', '2026-01-11'],
    ['2026-03-08T09:59:59Z', '2026-03-08'], ['2026-03-08T10:00:00Z', '2026-03-08'],
    ['2026-11-01T08:30:00Z', '2026-11-01'], ['2026-11-01T09:30:00Z', '2026-11-01'],
  ]) {
    assert.equal(calendarDateAt(zone, new Date(instant)), expected);
    assert.equal(dateInTimezone(zone, new Date(instant)), expected);
  }
});
test('events shift for the viewer while calendar labels and calendar navigation preserve dates', () => {
  assert.match(dateTime('2026-09-11T02:28:00Z', zone), /Sep 10, 2026.*7:28 PM PDT/);
  assert.match(dateTime('2026-09-11T02:28:00Z', 'Asia/Tokyo'), /Sep 11, 2026.*11:28 AM/);
  assert.match(dateTime('2026-01-11T02:28:00Z', zone), /Jan 10, 2026.*6:28 PM PST/);
  assert.match(calendarDateLabel('2026-09-10'), /Sep 10, 2026/);
  for (const [date, next] of [['2026-03-08','2026-03-09'], ['2026-11-01','2026-11-02'], ['2028-02-28','2028-02-29'], ['2026-12-31','2027-01-01']]) {
    assert.equal(moveCalendarDate(date, 1), next);
    assert.equal(moveCalendarDate(next, -1), date);
  }
});
test('invalid dates and preferences are rejected without treating epoch zero as absent', () => {
  assert.equal(validTimeZone('Mars/Base'), false);
  assert.equal(validTimeZone(null), false);
  assert.equal(validTimeZone(zone), true);
  assert.equal(dateTime('invalid', zone), '—');
  assert.match(dateTime(0, 'UTC'), /Jan 1, 1970/);
  assert.throws(() => moveCalendarDate('2026-02-30', 1));
  assert.throws(() => calendarDateLabel('2026-13-01'));
});
