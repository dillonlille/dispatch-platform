import { z } from 'zod';
import type { Storage } from '../../services/storage/index.js';
import type { Audit } from '../../services/audit/index.js';
import { assert } from '../../shared/errors.js';
import {
  paycomDefaults,
  type PaycomPreferences,
  type PaycomSettings,
} from '../../shared/paycom.js';
export const preferencesSchema = z
  .object({
    automatic_sync: z.boolean(),
    sync_interval_seconds: z.union([
      z.literal(1800),
      z.literal(3600),
      z.literal(7200),
      z.literal(14400),
    ]),
    opening_page: z.enum(['timecards', 'employees']),
    rows_per_page: z.union([z.literal(25), z.literal(50), z.literal(100)]),
    name_order: z.enum(['first_last', 'last_first']),
    default_sort: z.enum(['employeeName', 'condition', 'inDay']),
    department: z.string().max(200).nullable(),
    station: z.string().max(200).nullable(),
    columns: z
      .array(z.enum(['inDay', 'outLunch', 'inLunch', 'outDay', 'totalHours', 'condition']))
      .max(6)
      .refine((v) => new Set(v).size === v.length),
    driver_departments: z.array(z.string().max(200)).max(500).nullable(),
  })
  .strict();
type Stored = Pick<PaycomSettings, 'revision' | 'values' | 'history'>;
export function readPaycomSettings(storage: Storage, dspId: string): PaycomSettings {
  return storage.dsp(dspId, (db) => {
    const raw = db.one<{ value: string }>(
      "SELECT value FROM settings WHERE key='paycom.preferences'",
    );
    const stored: Stored = raw
      ? JSON.parse(raw.value)
      : { revision: 0, values: paycomDefaults, history: [] };
    const schedule = db.one<{ enabled: number }>(
      "SELECT enabled FROM schedules WHERE provider='paycom'",
    )!;
    return {
      ...stored,
      values: { ...stored.values, automatic_sync: Boolean(schedule.enabled) },
      options: {
        departments: db.all<{ value: string; count: number }>(
          'SELECT department value,count(*) count FROM employees WHERE publication_id=(SELECT id FROM publications WHERE active=1) GROUP BY department ORDER BY department',
        ),
        stations: db
          .all<{
            station: string;
          }>(
            'SELECT DISTINCT station FROM employees WHERE publication_id=(SELECT id FROM publications WHERE active=1) ORDER BY station',
          )
          .map((v) => v.station),
      },
    };
  });
}
export function writePaycomSettings(
  storage: Storage,
  audit: Audit,
  dspId: string,
  actorId: string,
  revision: number,
  values: PaycomPreferences,
) {
  preferencesSchema.parse(values);
  const before = readPaycomSettings(storage, dspId);
  storage.dsp(dspId, (db) =>
    db.transaction(() => {
      const raw = db.one<{ value: string }>(
        "SELECT value FROM settings WHERE key='paycom.preferences'",
      );
      const current = raw ? JSON.parse(raw.value).revision : 0;
      assert(current === revision, 'settings_changed_reload_before_saving', 409);
      const connected = db.one<{ enabled: number }>(
        "SELECT enabled FROM connections WHERE provider='paycom'",
      )!;
      assert(
        !values.automatic_sync || connected.enabled,
        'connect_paycom_before_automatic_sync',
        409,
      );
      const stored: Stored = {
        revision: revision + 1,
        values,
        history: [
          { revision: before.revision, at: new Date().toISOString(), values: before.values },
          ...before.history,
        ].slice(0, 20),
      };
      db.run(
        "INSERT INTO settings(key,value) VALUES ('paycom.preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(stored),
      );
      const scheduleChanged =
        !db.one("SELECT 1 FROM settings WHERE key='paycom.syncIntervalSeconds'") ||
        before.values.automatic_sync !== values.automatic_sync ||
        before.values.sync_interval_seconds !== values.sync_interval_seconds;
      db.run(
        "INSERT INTO settings(key,value) VALUES ('paycom.syncIntervalSeconds',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        String(values.sync_interval_seconds),
      );
      if (scheduleChanged)
        db.run(
          "UPDATE schedules SET enabled=?,next_run=? WHERE provider='paycom'",
          Number(values.automatic_sync),
          values.automatic_sync
            ? new Date(Date.now() + values.sync_interval_seconds * 1000).toISOString()
            : null,
        );
    }),
  );
  audit.record(actorId, dspId, 'paycom.settings_updated', `Revision ${revision + 1}`);
  return readPaycomSettings(storage, dspId);
}
