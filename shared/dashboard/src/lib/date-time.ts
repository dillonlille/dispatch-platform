// Event timestamps are instants; business dates are calendar labels. Keep the
// two operations explicit so viewing a DSP from another zone cannot move a day.
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format(0);
    return true;
  } catch { return false; }
}

export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

export function dateTime(value: string | number | Date, timeZone = deviceTimeZone()): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric",
    minute: "2-digit", timeZoneName: "short", timeZone,
  }).format(instant);
}

export function calendarDateAt(timeZone: string, instant: number | Date = new Date()): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarValue(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid_calendar_date");
  const value = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(value.valueOf()) || value.toISOString().slice(0, 10) !== date) {
    throw new Error("invalid_calendar_date");
  }
  return value;
}

export function moveCalendarDate(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error("invalid_calendar_date");
  const value = calendarValue(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function calendarDateLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(calendarValue(date));
}
