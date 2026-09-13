'use strict';

const { ValidationError } = require('dispatch-runtime-kit/collection-manager/src/validation');

function expandPart(part, min, max, sunday = false) {
  const values = new Set();
  const add = value => {
    if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError();
    values.add(sunday && value === 7 ? 0 : value);
  };
  for (const token of part.split(',')) {
    if (!token) throw new ValidationError();
    const [base, stepRaw, extra] = token.split('/');
    if (extra !== undefined) throw new ValidationError();
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new ValidationError();
    let start;
    let end;
    if (base === '*') [start, end] = [min, max];
    else if (base.includes('-')) {
      const pieces = base.split('-');
      if (pieces.length !== 2) throw new ValidationError();
      [start, end] = pieces.map(Number);
    } else {
      start = Number(base);
      end = Number(base);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new ValidationError();
    for (let value = start; value <= end; value += step) add(value);
  }
  return values;
}

function parseCron(expression) {
  if (typeof expression !== 'string') throw new ValidationError();
  const parts = expression.trim().split(/ +/);
  if (parts.length !== 5) throw new ValidationError();
  return {
    minute: expandPart(parts[0], 0, 59),
    hour: expandPart(parts[1], 0, 23),
    day: expandPart(parts[2], 1, 31),
    month: expandPart(parts[3], 1, 12),
    weekday: expandPart(parts[4], 0, 7, true),
    dayWildcard: parts[2] === '*',
    weekdayWildcard: parts[4] === '*',
  };
}

function zonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday,
    key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  };
}

function cronMatches(expression, timezone, date = new Date()) {
  const cron = parseCron(expression);
  const parts = zonedParts(date, timezone);
  const dayMatch = cron.day.has(parts.day);
  const weekdayMatch = cron.weekday.has(parts.weekday);
  let calendarMatch;
  if (cron.dayWildcard && cron.weekdayWildcard) calendarMatch = true;
  else if (cron.dayWildcard) calendarMatch = weekdayMatch;
  else if (cron.weekdayWildcard) calendarMatch = dayMatch;
  else calendarMatch = dayMatch || weekdayMatch;
  return cron.minute.has(parts.minute) && cron.hour.has(parts.hour) && cron.month.has(parts.month) && calendarMatch;
}

module.exports = { parseCron, zonedParts, cronMatches };
