import type { Punch, Timecard } from '../../shared/contracts/index.js';
import { assert } from '../../shared/errors.js';
export interface ProviderDay {
  date: string;
  hours: number | null;
  totalHours: number | null;
  missingPunch: boolean;
  punches: { slot: string; displayTime: string; rowIndex: number }[];
}
export interface ProviderTimecard {
  days: ProviderDay[];
  additionalRows: { date: string; hours: number | null; totalHours: number | null }[];
  weeklyTotals: (number | null)[];
  periodTotalHours: number | null;
}
/** Runs after the strict provider DOM/identity validator. */
export function projectTimecards(record: ProviderTimecard, employeeCode: string): Timecard[] {
  const base = record.days.map(
    (day) => day.totalHours ?? day.hours ?? (!day.missingPunch && !day.punches.length ? 0 : null),
  );
  assert(
    base.every((value) => value !== null),
    'invalid_timecard_hours',
    409,
  );
  const rows = record.days.map(
    (day, index) =>
      base[index]! +
      record.additionalRows
        .filter((row) => row.date === day.date)
        .reduce((sum, row) => sum + (row.totalHours ?? row.hours ?? 0), 0),
  );
  const matches = (hours: number[]) =>
    record.weeklyTotals.every(
      (value, index) =>
        value !== null &&
        Math.abs(hours.slice(index * 7, index * 7 + 7).reduce((sum, h) => sum + h, 0) - value) <
          0.011,
    ) &&
    record.periodTotalHours !== null &&
    Math.abs(hours.reduce((sum, h) => sum + h, 0) - record.periodTotalHours) < 0.011;
  // Some provider layouts put the day's aggregate in the leading row; others
  // expose totals per pay-code row. Require agreement with both weekly totals.
  const hours = matches(rows) ? rows : matches(base as number[]) ? (base as number[]) : null;
  assert(hours, 'provider_hours_mismatch', 409);
  return record.days.map((day, index) => {
    const punches: Punch[] = [];
    let pending: string | null = null,
      previousRow = -1;
    for (const punch of day.punches) {
      if (punch.rowIndex !== previousRow && pending) {
        punches.push({ in: pending, out: null, hours: null });
        pending = null;
      }
      previousRow = punch.rowIndex;
      if (punch.slot.startsWith('i')) {
        if (pending) punches.push({ in: pending, out: null, hours: null });
        pending = punch.displayTime;
      } else {
        punches.push({ in: pending, out: punch.displayTime, hours: null });
        pending = null;
      }
    }
    if (pending) punches.push({ in: pending, out: null, hours: null });
    return {
      employeeCode,
      date: day.date,
      hours: Number(hours[index]!.toFixed(2)),
      status: day.missingPunch ? 'Missing punch' : punches.length ? 'Complete' : 'No punches',
      punches,
    };
  });
}
