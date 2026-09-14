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
test('daily totals on trailing pay-code rows reconcile mixed layouts without double counting', () => {
  const record: ProviderTimecard = {
    days: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      hours: null,
      totalHours: null,
      missingPunch: false,
      punches: [],
    })),
    additionalRows: [],
    weeklyTotals: [18, 7.5],
    periodTotalHours: 25.5,
  };
  // Leading daily aggregate, trailing daily aggregate, individual row totals,
  // and hours-only rows can coexist on the same timecard.
  Object.assign(record.days[0]!, { hours: 8, totalHours: 10 });
  Object.assign(record.days[2]!, { hours: 6.5 });
  Object.assign(record.days[7]!, { hours: 4.25, totalHours: 4.25 });
  Object.assign(record.days[10]!, { hours: 2 });
  record.additionalRows = [
    { date: record.days[0]!.date, hours: 2, totalHours: null },
    { date: record.days[2]!.date, hours: 1.5, totalHours: 8 },
    { date: record.days[7]!.date, hours: 0.75, totalHours: 0.75 },
    { date: record.days[10]!.date, hours: 0.5, totalHours: null },
  ];
  const days = projectTimecards(record, 'E001');
  assert.deepEqual(
    days.map((day) => day.hours),
    [10, 0, 8, 0, 0, 0, 0, 5, 0, 0, 2.5, 0, 0, 0],
  );
  assert.equal(
    days.reduce((sum, day) => sum + day.hours, 0),
    25.5,
  );

  // An equal period total cannot conceal hours assigned to the wrong week.
  record.weeklyTotals = [17, 8.5];
  assert.throws(() => projectTimecards(record, 'E001'), { code: 'provider_hours_mismatch' });
  record.weeklyTotals = [18, 7.5];
  record.periodTotalHours = 24.5;
  assert.throws(() => projectTimecards(record, 'E001'), { code: 'provider_hours_mismatch' });
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
