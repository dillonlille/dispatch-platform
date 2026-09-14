import type { Schedule } from '../../shared/contracts/index.js';
import type { Storage } from '../storage/index.js';
import { assert } from '../../shared/errors.js';
export function nextOccurrence(localTime: string, timezone: string, after = new Date()): string {
  assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime), 'invalid_schedule_time');
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  // UTC iteration naturally handles DST gaps and repeated wall-clock minutes.
  let time = Math.floor(+after / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 3 * 24 * 60; minute++, time += 60_000)
    if (formatter.format(time) === localTime) return new Date(time).toISOString();
  throw new Error('schedule_unresolvable');
}
export class Schedules {
  constructor(private storage: Storage) {}
  get(dspId: string): Schedule {
    return this.storage.dsp(dspId, (db) => {
      const row = db.one<{
        enabled: number;
        local_time: string;
        timezone: string;
        next_run: string | null;
      }>("SELECT * FROM schedules WHERE provider='paycom'")!;
      return {
        enabled: Boolean(row.enabled),
        localTime: row.local_time,
        timezone: row.timezone,
        nextRun: row.next_run,
      };
    });
  }
  set(dspId: string, enabled: boolean, localTime: string, timezone: string) {
    const next = enabled ? nextOccurrence(localTime, timezone) : null;
    this.storage.dsp(dspId, (db) =>
      db.run(
        "UPDATE schedules SET enabled=?,local_time=?,timezone=?,next_run=? WHERE provider='paycom'",
        Number(enabled),
        localTime,
        timezone,
        next,
      ),
    );
    return this.get(dspId);
  }
}
