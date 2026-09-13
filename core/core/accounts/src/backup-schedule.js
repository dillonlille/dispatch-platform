'use strict';
const { AccessError, exact, timezone } = require('./validation');
const DEFAULT_BACKUP_SETTINGS = Object.freeze({
  enabled: false,
  frequency: 'daily',
  time: '02:00',
  timezone: 'America/Los_Angeles',
  weekday: 0,
  retentionDays: null,
});
function backupSettings(value) {
  exact(value, Object.keys(DEFAULT_BACKUP_SETTINGS));
  if (
    Object.keys(value).length !== Object.keys(DEFAULT_BACKUP_SETTINGS).length ||
    typeof value.enabled !== 'boolean' ||
    !['hourly', 'daily', 'weekly'].includes(value.frequency) ||
    !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.time) ||
    !Number.isInteger(value.weekday) ||
    value.weekday < 0 ||
    value.weekday > 6 ||
    ![null, 7, 30, 90, 365].includes(value.retentionDays)
  )
    throw new AccessError('invalid_input');
  return { ...value, timezone: timezone(value.timezone) };
}
function scheduleClock(settings) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  return (now) => Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
}
function scheduledSlot(settings, now, parts = scheduleClock(settings)(now)) {
  if (!settings.enabled) return null;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // A repeated DST hour runs once. A skipped daily clock time runs at the first
  // available minute after it. No backlog of obsolete snapshots is generated.
  if (settings.frequency === 'hourly') return `${date}T${parts.hour}`;
  if (`${parts.hour}:${parts.minute}` < settings.time) return null;
  if (
    settings.frequency === 'weekly' &&
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) !== settings.weekday
  )
    return null;
  return date;
}
function nextScheduledAt(settings, now) {
  if (!settings.enabled) return null;
  const parts = scheduleClock(settings),
    current = scheduledSlot(settings, now, parts(now));
  const start = Math.floor(now / 60000) * 60000 + 60000;
  for (let at = start; at < start + 8 * 86400000; at += 60000) {
    const slot = scheduledSlot(settings, at, parts(at));
    if (slot && slot !== current) return new Date(at).toISOString();
  }
  return null;
}
module.exports = { DEFAULT_BACKUP_SETTINGS, backupSettings, scheduledSlot, nextScheduledAt };
