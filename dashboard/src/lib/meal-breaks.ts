import { dateFormatter } from './date-format.js';
import type { AssessedClock, PaycomDay } from '../../../shared/contracts/workforce.js';
import type {
  DeliveryGap as Gap,
  MealEmployee,
  MealStatus,
} from '../../../shared/contracts/meals.js';
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
export interface DeliveryGap extends Gap {
  label: string;
}
export function gapLabel(milliseconds: number) {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes ? `${minutes}m ` : ''}${remainder}s` : `${minutes}m`;
}
const displayGap = (gap: Gap | null): DeliveryGap | null =>
  gap ? { ...gap, label: gapLabel(gap.milliseconds) } : null;

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
export function clockLabel(value: string) {
  const minute = parseClock(value);
  return minute === null ? value : label(minute);
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
const statusLabels = {
  flex_only: 'Flex only',
  no_flex_meal: 'No Flex meal',
  review_punches: 'Review Paycom punches',
  missing_lunch: 'Missing Paycom lunch',
  review_pairing: 'Review meal pairing',
  missing_data: 'Missing data',
  different: 'Different times',
  same: 'Same times',
} satisfies Record<MealStatus, string>;

function paycomClock(clock: AssessedClock | null): ClockTime | null {
  return clock
    ? {
        ...clock,
        label: label(clock.minute),
        detail: `Paycom displayed time${clock.day ? ` · day +${clock.day}` : ''}`,
      }
    : null;
}
function displayDay(day: PaycomDay) {
  return {
    ...day,
    inDay: paycomClock(day.inDay),
    outDay: paycomClock(day.outDay),
    lunches: day.lunches.map((lunch) => ({
      out: paycomClock(lunch.out),
      in: paycomClock(lunch.in),
    })),
    events: day.events.map((event) => ({ ...event, time: paycomClock(event.time) })),
  };
}
/** Format the server's assessment; pairing and decisions are already final. */
export function displayMeal(row: MealEmployee) {
  const assessment = row.assessment;
  const paycom = displayDay(assessment.paycom);
  return {
    ...assessment,
    paycom,
    status: statusLabels[assessment.status],
    pairs: assessment.pairs.map((pair) => {
      const cortex = pair.cortexIndex === null ? undefined : row.cortex[pair.cortexIndex];
      const lunch = pair.lunchIndex === null ? undefined : paycom.lunches[pair.lunchIndex];
      const flexClock = (clock: AssessedClock | null, instant?: string | null) => {
        if (!clock || !cortex || !instant) return null;
        return {
          ...clock,
          label: label(clock.minute),
          detail: `${dateFormatter('en-US', { timeZone: cortex.timezone, dateStyle: 'medium', timeStyle: 'long' }).format(new Date(instant))} · ${cortex.timezone}`,
        };
      };
      return {
        ...pair,
        cortex,
        lunch,
        out: flexClock(pair.out, cortex?.start),
        into: flexClock(pair.into, cortex?.end),
        gaps: { before: displayGap(pair.gaps.before), after: displayGap(pair.gaps.after) },
      };
    }),
  };
}
