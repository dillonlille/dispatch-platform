import { dateFormatter } from '../../../shared/date-format.js';

// Platform owner pages span every DSP, so they show the viewer's device time.
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
// DSP pages pass the DSP's timezone so every member reads the same clock.
export const time = (value: string | null | undefined, timeZone: string) =>
  value
    ? dateFormatter('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }).format(new Date(value))
    : 'Never';
export const title = (value: string) =>
  value
    .replaceAll('_', ' ')
    .replaceAll('.', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
