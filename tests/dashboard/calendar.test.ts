import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays,
  addMonths,
  clampDay,
  dayLabel,
  displayDay,
  monthLabel,
  monthWeeks,
  parseDay,
  sameDayOf,
} from '../../dashboard/src/lib/calendar.js';

test('days and months roll over years, leap days and daylight saving', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  // United States clocks change on these dates; a day must still be a day.
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
});

test('moving a day to a shorter month keeps it inside that month', () => {
  assert.equal(sameDayOf('2026-01-31', '2026-02'), '2026-02-28');
  assert.equal(sameDayOf('2024-01-31', '2024-02'), '2024-02-29');
  assert.equal(sameDayOf('2026-09-19', '2026-08'), '2026-08-19');
});

test('a month is laid out in full weeks that start on Sunday', () => {
  const weeks = monthWeeks('2026-09');
  assert.equal(weeks.length, 5);
  assert.deepEqual(weeks[0], [
    null,
    null,
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
    '2026-09-05',
  ]);
  assert.deepEqual(weeks.at(-1)!.slice(0, 4), [
    '2026-09-27',
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
  ]);
  assert(weeks.every((week) => week.length === 7));
  // February 2026 starts on a Sunday and fills exactly four weeks.
  assert.equal(monthWeeks('2026-02').length, 4);
  assert.equal(monthWeeks('2026-08').length, 6);
  assert.equal(monthWeeks('2026-08').flat().filter(Boolean).length, 31);
});

test('days are clamped and named', () => {
  assert.equal(clampDay('2026-09-25', '2000-01-01', '2026-09-19'), '2026-09-19');
  assert.equal(clampDay('1999-01-01', '2000-01-01', '2026-09-19'), '2000-01-01');
  assert.equal(monthLabel('2026-09'), 'September 2026');
  assert.equal(dayLabel('2026-09-19'), 'Saturday, September 19, 2026');
});

test('a typed day is read in either form and refused when it is not a real day', () => {
  assert.equal(displayDay('2026-09-05'), '09/05/2026');
  assert.equal(parseDay('9/5/2026'), '2026-09-05');
  assert.equal(parseDay(' 09/05/2026 '), '2026-09-05');
  assert.equal(parseDay('2026-09-05'), '2026-09-05');
  assert.equal(parseDay('2/29/2024'), '2024-02-29');
  for (const text of [
    '2/29/2026',
    '02/30/2026',
    '13/01/2026',
    '0/10/2026',
    '9/5/26',
    '9/5',
    'today',
    '',
  ])
    assert.equal(parseDay(text), undefined, text);
});
