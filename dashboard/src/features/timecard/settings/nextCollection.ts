import { time } from '../../../lib/format.js';

export const nextCollection = (value: string | null, timezone: string) =>
  time(value, timezone, 'Not scheduled');
