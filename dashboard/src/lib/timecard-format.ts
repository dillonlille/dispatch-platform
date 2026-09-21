import { dateFormatter } from './date-format.js';

export function hoursAndMinutes(hours: number) {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
export const timecardDate = (date: string) =>
  dateFormatter('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
export const timecardPeriod = (from: string, to: string) =>
  dateFormatter('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatRange(new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`));
// Punch clocks are already in Paycom's local timezone; never reinterpret them as UTC.
export function punchTime(value: string | null | undefined) {
  if (!value) return '—';
  const clock = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!clock) return value;
  const hour = Number(clock[1]);
  if (hour > 23 || Number(clock[2]) > 59) return value;
  return `${hour % 12 || 12}:${clock[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
}
