import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTimecards, type ProviderTimecard } from '../integrations/paycom/timecards.js';
test('provider totals include additional rows without double-counting aggregate layouts', () => {
  const record: ProviderTimecard = {
    days: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      hours: i === 0 ? 8 : null,
      totalHours: null,
      missingPunch: false,
      punches: [],
    })),
    additionalRows: [{ date: '2026-09-01', hours: 2, totalHours: null }],
    weeklyTotals: [10, 0],
    periodTotalHours: 10,
  };
  assert.equal(projectTimecards(record, 'E001')[0]!.hours, 10);
  record.days[0]!.totalHours = 10;
  assert.equal(projectTimecards(record, 'E001')[0]!.hours, 10);
  record.weeklyTotals = [9, 0];
  assert.throws(() => projectTimecards(record, 'E001'));
});
test('unresolved punches do not create invented durations or pair across source rows', () => {
  const record: ProviderTimecard = {
    days: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      hours: i === 0 ? 4 : null,
      totalHours: null,
      missingPunch: i === 0,
      punches:
        i === 0
          ? [
              { slot: 'i1', displayTime: '08:00 AM', rowIndex: 0 },
              { slot: 'o1', displayTime: '12:00 PM', rowIndex: 1 },
            ]
          : [],
    })),
    additionalRows: [],
    weeklyTotals: [4, 0],
    periodTotalHours: 4,
  };
  const day = projectTimecards(record, 'E001')[0]!;
  assert.equal(day.status, 'Missing punch');
  assert.deepEqual(day.punches, [
    { in: '08:00 AM', out: null, hours: null },
    { in: null, out: '12:00 PM', hours: null },
  ]);
});
