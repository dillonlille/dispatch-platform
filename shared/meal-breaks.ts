import { dateFormatter } from './date-format.js';
import type { Punch } from './contracts/index.js';

export interface CortexMeal {
  mealId: string;
  itineraryId: string;
  cortexId: string;
  driverName: string;
  station: string;
  timezone: string;
  collectedAt: string;
  lastDelivery: string | null;
  start: string;
  end: string | null;
  firstDelivery: string | null;
  beforeStatus: string;
  afterStatus: string;
}
export interface MealEmployee {
  id: string;
  name: string;
  paycom: { employeeCode: string; name: string; status: string; punches: Punch[] } | null;
  cortex: CortexMeal[];
}
export interface EmployeeLink {
  id: string;
  cortexId: string;
  paycomCode: string;
}
export interface MealComparison {
  date: string;
  timezone: string;
  rows: MealEmployee[];
  paycomCollectedAt: string | null;
  cortexPublications: { station: string; timezone: string; collectedAt: string }[];
  employees: { code: string; name: string }[];
  drivers: {
    id: string;
    name: string;
    paycomCode: string | null;
    matchType: 'name' | 'saved' | 'separate' | 'unmatched';
  }[];
  links: { revision: number; links: EmployeeLink[]; separate?: string[] };
}
export interface ClockTime {
  minute: number;
  label: string;
  day: number;
  detail: string;
}
export interface Lunch {
  out: ClockTime | null;
  in: ClockTime | null;
}
export interface DeliveryGap {
  milliseconds: number;
  label: string;
  overLimit: boolean;
}

// Both endpoints belong to the same Flex meal. Never use Paycom punches or
// displayed clock minutes: elapsed instants also handle midnight and DST.
export function flexDeliveryGaps(meal: CortexMeal | undefined) {
  const gap = (start: string | null, end: string | null, status: string): DeliveryGap | null => {
    if (status !== 'verified' || !start || !end) return null;
    const milliseconds = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
    // Keep sub-minute precision visible, particularly around the five-minute
    // boundary. Round display upwards to the second, never the threshold itself.
    const seconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return {
      milliseconds,
      label: remainder ? `${minutes ? `${minutes}m ` : ''}${remainder}s` : `${minutes}m`,
      overLimit: milliseconds > 5 * 60 * 1000,
    };
  };
  return {
    before: meal ? gap(meal.lastDelivery, meal.start, meal.beforeStatus) : null,
    after: meal ? gap(meal.end, meal.firstDelivery, meal.afterStatus) : null,
  };
}

export function fullName(name: string) {
  const comma = name.indexOf(',');
  return (comma < 0 ? name : `${name.slice(comma + 1)} ${name.slice(0, comma)}`)
    .trim()
    .replace(/\s+/g, ' ');
}
export function localDate(timezone: string, now = new Date()) {
  return dateFormatter('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function label(minute: number) {
  const m = ((minute % 1440) + 1440) % 1440,
    hour = Math.floor(m / 60);
  return `${hour % 12 || 12}:${String(m % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
function parseClock(value: string | null) {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i.exec(value.trim());
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59 || (match[3] ? h < 1 || h > 12 : h > 23)) return null;
  if (match[3]) h = (h % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return h * 60 + m;
}
export function cortexClock(value: string | null, date: string, zone: string): ClockTime | null {
  if (!value) return null;
  const d = new Date(value);
  const parts = dateFormatter('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const day = Math.round(
    (Date.parse(`${localDate(zone, d)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000,
  );
  const minute =
    day * 1440 +
    Number(parts.find((p) => p.type === 'hour')!.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')!.value);
  return {
    minute,
    day,
    label: label(minute),
    detail: `${dateFormatter('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'long' }).format(d)} · ${zone}`,
  };
}
export function paycomDay(source: MealEmployee['paycom']) {
  const punches = source?.punches ?? [];
  const typed = punches.some((p) => 'inKind' in p || 'outKind' in p);
  // Historical complete cards support the same one/two-pair layout as Timecard.
  // Incomplete or more complex unlabeled cards cannot establish punch kinds.
  const legacy =
    !typed &&
    source?.status === 'Complete' &&
    punches.length > 0 &&
    punches.length <= 2 &&
    punches.every((p) => parseClock(p.in) !== null && parseClock(p.out) !== null);
  let review = punches.length > 0 && !typed && !legacy;
  let previous = -1,
    day = 0;
  let inDay: ClockTime | null = null,
    outDay: ClockTime | null = null;
  const lunches: Lunch[] = [];
  const events: { kind: string; time: ClockTime | null; raw: string }[] = [];
  for (const [i, punch] of punches.entries()) {
    for (const direction of ['in', 'out'] as const) {
      const raw = punch[direction];
      if (!raw?.trim()) continue;
      const clock = parseClock(raw);
      if (clock !== null && clock < previous) {
        // A small backwards jump may be a DST repeat or an out-of-order punch,
        // not midnight. Preserve the clock and require review in that case.
        if (previous - clock > 12 * 60) day++;
        else review = true;
      }
      if (clock !== null) previous = clock;
      const time =
        clock === null
          ? null
          : {
              minute: clock + day * 1440,
              day,
              label: label(clock),
              detail: `Paycom displayed time${day ? ` · day +${day}` : ''}`,
            };
      const kind =
        (typed
          ? punch[direction === 'in' ? 'inKind' : 'outKind']
          : legacy
            ? direction === 'in'
              ? i === 0
                ? 'IN DAY'
                : 'IN LUNCH'
              : i === punches.length - 1
                ? 'OUT DAY'
                : 'OUT LUNCH'
            : null) ?? 'Unlabeled punch';
      events.push({ kind, time, raw });
      if (!time || kind === 'Unlabeled punch' || day > 1) review = true;
      if (kind === 'IN DAY' && !inDay) inDay = time;
      if (kind === 'OUT DAY') outDay = time;
      if (kind === 'OUT LUNCH') lunches.push({ out: time, in: null });
      if (kind === 'IN LUNCH') {
        const pending = lunches.at(-1);
        if (pending && !pending.in) pending.in = time;
        else lunches.push({ out: null, in: time });
      }
    }
  }
  return { inDay, outDay, lunches, events, review, legacy };
}
export function mealPairs(row: MealEmployee, date: string) {
  const paycom = paycomDay(row.paycom);
  const comparable = !paycom.review && paycom.lunches.length === row.cortex.length;
  const pairs = Array.from(
    { length: Math.max(paycom.lunches.length, row.cortex.length, 1) },
    (_, i) => {
      const cortex = row.cortex[i];
      const lunch = paycom.lunches[i];
      const out = cortex ? cortexClock(cortex.start, date, cortex.timezone) : null;
      const into = cortex ? cortexClock(cortex.end, date, cortex.timezone) : null;
      const difference = (a: ClockTime | null | undefined, b: ClockTime | null) =>
        comparable && a && b ? b.minute - a.minute : null;
      return {
        cortex,
        gaps: flexDeliveryGaps(cortex),
        lunch,
        out,
        into,
        outDifference: difference(lunch?.out, out),
        inDifference: difference(lunch?.in, into),
      };
    },
  );
  const different = pairs.some(
    (p) =>
      (p.outDifference !== null && p.outDifference !== 0) ||
      (p.inDifference !== null && p.inDifference !== 0),
  );
  const longGap = pairs.some((p) => p.gaps.before?.overLimit || p.gaps.after?.overLimit);
  const missing =
    !row.paycom ||
    !row.cortex.length ||
    paycom.review ||
    !paycom.inDay ||
    !paycom.outDay ||
    !comparable ||
    pairs.some(
      (p) =>
        !p.lunch?.out ||
        !p.lunch.in ||
        !p.out ||
        !p.into ||
        !p.cortex?.lastDelivery ||
        !p.cortex.firstDelivery,
    );
  const status = !row.paycom
    ? 'Flex only'
    : !row.cortex.length
      ? 'No Flex meal'
      : paycom.review
        ? 'Review Paycom punches'
        : !paycom.lunches.length
          ? 'Missing Paycom lunch'
          : !comparable
            ? 'Review meal pairing'
            : missing
              ? 'Missing data'
              : different
                ? 'Different times'
                : 'Same times';
  return { paycom, pairs, different, missing, status, longGap };
}
