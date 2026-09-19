import { dateFormatter } from '../../../shared/date-format.js';
import { fullName } from '../../../shared/meal-breaks.js';
import { employeeName, type PaycomPreferences } from '../../../shared/paycom.js';

// Platform owner pages span every DSP, so they show the viewer's device time.
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
// DSP pages pass the DSP's timezone so every member reads the same clock.
export const time = (value: string | null | undefined, timeZone: string, empty = 'Never') =>
  value
    ? dateFormatter('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }).format(new Date(value))
    : empty;
export const timeOfDay = (value: string, timeZone: string) =>
  dateFormatter('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(value));
// "Pacific Time" for America/Los_Angeles; the zone ID when the runtime has no name for it.
export const timezoneName = (timeZone: string) => {
  try {
    return (
      dateFormatter('en-US', { timeZone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
    );
  } catch {
    return timeZone;
  }
};
export const title = (value: string) =>
  value
    .replaceAll('_', ' ')
    .replaceAll('.', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
export function duration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
// Whole seconds, as the audit log records them.
export function elapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
export const bytes = (value: number, unit: 'MiB' | 'GiB', digits = 0) =>
  `${(value / 1024 ** (unit === 'GiB' ? 3 : 2)).toFixed(digits)} ${unit}`;
// Providers write "Last, First"; a name already in the chosen order is kept as written.
export function personName(name: string, order: PaycomPreferences['name_order']) {
  const value = fullName(name);
  return order === 'last_first' && name.includes(',') && value.includes(' ')
    ? name
    : employeeName(value, order);
}
