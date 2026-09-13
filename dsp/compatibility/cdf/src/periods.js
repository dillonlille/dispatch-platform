'use strict';

const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function fail(code = 'invalid_period') {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail();
  return date;
}

function formatDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function isoWeek(dateValue) {
  const date = new Date(Date.UTC(dateValue.getUTCFullYear(), dateValue.getUTCMonth(), dateValue.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return { year, week, key: `${year}-W${String(week).padStart(2, '0')}` };
}

function periodFromWeek(value) {
  const match = typeof value === 'string' ? WEEK_RE.exec(value) : null;
  if (!match) fail();
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const januaryFourthDay = (januaryFourth.getUTCDay() + 6) % 7;
  const isoMonday = new Date(januaryFourth.valueOf() - januaryFourthDay * DAY_MS + (week - 1) * 7 * DAY_MS);
  if (isoWeek(isoMonday).key !== value) fail();
  const start = new Date(isoMonday.valueOf() - DAY_MS);
  const end = new Date(start.valueOf() + 6 * DAY_MS);
  return { key: value, start: formatDate(start), end: formatDate(end) };
}

function weekForSourceDate(value) {
  const date = parseDate(value);
  return isoWeek(new Date(date.valueOf() + DAY_MS)).key;
}

function previousWeek(value) {
  const period = periodFromWeek(value);
  return weekForSourceDate(formatDate(new Date(parseDate(period.start).valueOf() - DAY_MS)));
}

function nextWeek(value) {
  const period = periodFromWeek(value);
  return weekForSourceDate(formatDate(new Date(parseDate(period.end).valueOf() + DAY_MS)));
}

function validateCompletedWeek(value, today) {
  const period = periodFromWeek(value);
  if (period.end >= formatDate(parseDate(today))) fail('week_not_completed');
  return period;
}

function dateInTimezone(timezone, now = new Date()) {
  if (typeof timezone !== 'string' || timezone.length < 1 || timezone.length > 64) fail();
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  } catch { fail(); }
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function resolveTargets(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.selectorKind !== 'string') fail();
  let weeks;
  if (input.selectorKind === 'date') {
    if (Object.keys(input).sort().join(',') !== 'date,selectorKind') fail();
    weeks = [weekForSourceDate(input.date)];
  } else if (input.selectorKind === 'latest-complete') {
    if (Object.keys(input).sort().join(',') !== 'date,selectorKind') fail();
    weeks = [previousWeek(weekForSourceDate(input.date))];
  } else if (input.selectorKind === 'exact-target') {
    if (Object.keys(input).sort().join(',') !== 'key,selectorKind') fail();
    weeks = [periodFromWeek(input.key).key];
  } else if (input.selectorKind === 'date-range') {
    if (Object.keys(input).sort().join(',') !== 'end,selectorKind,start') fail();
    const start = parseDate(input.start);
    const end = parseDate(input.end);
    if (start > end || ((end - start) / DAY_MS) + 1 > 730) fail();
    const found = new Set();
    for (let current = start; current <= end; current = new Date(current.valueOf() + DAY_MS)) {
      found.add(weekForSourceDate(formatDate(current)));
    }
    weeks = [...found];
  } else if (input.selectorKind === 'target-range') {
    if (Object.keys(input).sort().join(',') !== 'date,endKey,selectorKind,startKey') fail();
    const start = periodFromWeek(input.startKey);
    const end = periodFromWeek(input.endKey);
    if (start.start > end.start) fail('invalid_period');
    weeks = [];
    for (let week = start.key; ; week = nextWeek(week)) {
      validateCompletedWeek(week, input.date);
      weeks.push(week);
      if (week === end.key) break;
      if (weeks.length >= 64) fail('target_range_too_large');
    }
  } else fail();
  return {
    targetType: 'cdf-week',
    targets: weeks.map(week => {
      const period = periodFromWeek(week);
      return { key: week, start: period.start, end: period.end, values: { week } };
    }),
  };
}

module.exports = {
  WEEK_RE, DATE_RE, DAY_MS, parseDate, formatDate, isoWeek, periodFromWeek,
  weekForSourceDate, previousWeek, nextWeek, validateCompletedWeek, dateInTimezone, resolveTargets,
};
