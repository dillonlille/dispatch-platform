// Calendar arithmetic on `YYYY-MM-DD` days and `YYYY-MM` months. Everything runs in UTC, so a
// day never shifts with the viewer's timezone or a daylight-saving change.
const pad = (value: number) => String(value).padStart(2, '0');
const parse = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date ?? 1));
};
const format = (value: Date) =>
  `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;

/** 0 for Sunday through 6 for Saturday. */
export const weekdayOf = (day: string) => parse(day).getUTCDay();
export const monthOf = (day: string) => day.slice(0, 7);
export function addDays(day: string, count: number) {
  const value = parse(day);
  value.setUTCDate(value.getUTCDate() + count);
  return format(value);
}
export function addMonths(month: string, count: number) {
  const value = parse(month);
  value.setUTCMonth(value.getUTCMonth() + count);
  return format(value).slice(0, 7);
}
/** The same day of another month, or that month's last day when it is shorter. */
export function sameDayOf(day: string, month: string) {
  const last = parse(addMonths(month, 1));
  last.setUTCDate(0);
  return `${month}-${pad(Math.min(Number(day.slice(8)), last.getUTCDate()))}`;
}
/** A month as weeks that start on Sunday, with `null` where a week reaches outside the month. */
export function monthWeeks(month: string) {
  const first = parse(month);
  const cells: (string | null)[] = Array<null>(first.getUTCDay()).fill(null);
  for (let day = `${month}-01`; monthOf(day) === month; day = addDays(day, 1)) cells.push(day);
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}
export const clampDay = (day: string, min: string, max: string) =>
  day < min ? min : day > max ? max : day;

const monthName = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const dayName = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });
export const monthLabel = (month: string) => monthName.format(parse(month));
export const dayLabel = (day: string) => dayName.format(parse(day));
