import { z } from 'zod';
import type { Storage } from '../../services/storage/index.js';
import type { Workforce, Employee, Timecard } from '../../shared/contracts/index.js';
import { id } from '../../shared/crypto.js';
import { assert } from '../../shared/errors.js';
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
  });
const text = z.string().max(200);
export const workforceSchema = z
  .object({
    employees: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
            name: text.min(1),
            department: text,
            position: text,
            station: text,
            active: z.boolean(),
          })
          .strict(),
      )
      .max(5000),
    timecards: z
      .array(
        z
          .object({
            employeeCode: z.string(),
            date: dateSchema,
            hours: z.number().min(0).max(48),
            status: text,
            punches: z
              .array(
                z
                  .object({
                    in: z.string().max(64).nullable(),
                    out: z.string().max(64).nullable(),
                    hours: z.number().min(0).max(48).nullable(),
                  })
                  .strict(),
              )
              .max(64),
          })
          .strict(),
      )
      .max(160000),
    collectedAt: z.iso.datetime(),
    from: dateSchema,
    to: dateSchema,
  })
  .strict();
export class WorkforceStore {
  constructor(readonly storage: Storage) {}
  publish(dspId: string, input: unknown, guard: () => void = () => {}) {
    const value = workforceSchema.parse(input);
    assert(value.from <= value.to, 'invalid_period');
    const codes = new Set(value.employees.map((e) => e.code));
    assert(codes.size === value.employees.length, 'duplicate_employee');
    const days = new Set<string>();
    for (const row of value.timecards) {
      assert(
        codes.has(row.employeeCode) && row.date >= value.from && row.date <= value.to,
        'timecard_identity_mismatch',
      );
      const key = `${row.employeeCode}:${row.date}`;
      assert(!days.has(key), 'duplicate_timecard');
      days.add(key);
    }
    guard();
    this.storage.dsp(dspId, (db) =>
      db.transaction(() => {
        guard();
        const publication = id('pub');
        db.run(
          'INSERT INTO publications(id,collected_at,period_from,period_to) VALUES (?,?,?,?)',
          publication,
          value.collectedAt,
          value.from,
          value.to,
        );
        for (const e of value.employees)
          db.run(
            'INSERT INTO employees(publication_id,code,name,department,position,station,active) VALUES (?,?,?,?,?,?,?)',
            publication,
            e.code,
            e.name,
            e.department,
            e.position,
            e.station,
            Number(e.active),
          );
        for (const t of value.timecards)
          db.run(
            'INSERT INTO timecards VALUES (?,?,?,?,?,?)',
            publication,
            t.employeeCode,
            t.date,
            t.hours,
            t.status,
            JSON.stringify(t.punches),
          );
        guard();
        db.run('UPDATE publications SET active=0 WHERE active=1');
        db.run('UPDATE publications SET active=1 WHERE id=?', publication);
      }),
    );
    return {
      employees: value.employees.length,
      timecards: value.timecards.length,
      collectedAt: value.collectedAt,
    };
  }
  employees(dspId: string, query = '', offset = 0, limit = 50) {
    return this.storage.dsp(dspId, (db) => {
      const pub = db.one<{ id: string; collected_at: string }>(
        'SELECT * FROM publications WHERE active=1',
      );
      if (!pub) return { employees: [], total: 0, collectedAt: null };
      const escaped = `%${query.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const where = `publication_id=? AND (lower(name) LIKE ? ESCAPE '\\' OR lower(code) LIKE ? ESCAPE '\\')`;
      const total = db.one<{ n: number }>(
        `SELECT count(*) n FROM employees WHERE ${where}`,
        pub.id,
        escaped,
        escaped,
      )!.n;
      const employees = db
        .all<
          Omit<Employee, 'active'> & { active: number }
        >(`SELECT code,name,department,position,station,active FROM employees WHERE ${where} ORDER BY name COLLATE NOCASE,code LIMIT ? OFFSET ?`, pub.id, escaped, escaped, limit, offset)
        .map((row) => ({ ...row, active: Boolean(row.active) }));
      return { employees, total, collectedAt: pub.collected_at };
    });
  }
  daily(
    dspId: string,
    date: string,
    sort: 'name' | 'hours' = 'name',
    direction: 'asc' | 'desc' = 'asc',
  ) {
    dateSchema.parse(date);
    return this.storage.dsp(dspId, (db) => {
      const pub = db.one<{ id: string; collected_at: string }>(
        'SELECT * FROM publications WHERE period_from<=? AND period_to>=? ORDER BY collected_at DESC LIMIT 1',
        date,
        date,
      );
      if (!pub) return { rows: [], collectedAt: null, available: false };
      const order = sort === 'hours' ? 't.hours' : 'e.name COLLATE NOCASE';
      const rows = db
        .all<
          Timecard & { name: string; punches: string }
        >(`SELECT t.employee_code employeeCode,e.name,t.date,t.hours,t.status,t.punches FROM timecards t JOIN employees e ON e.publication_id=t.publication_id AND e.code=t.employee_code WHERE t.publication_id=? AND t.date=? ORDER BY ${order} ${direction === 'desc' ? 'DESC' : 'ASC'},e.code`, pub.id, date)
        .map((row) => ({ ...row, punches: JSON.parse(row.punches) as Timecard['punches'] }));
      return { rows, collectedAt: pub.collected_at, available: true };
    });
  }
  employee(dspId: string, code: string) {
    return this.storage.dsp(dspId, (db) => {
      const row = db.one<Omit<Employee, 'active'> & { active: number; publication_id: string }>(
        'SELECT e.* FROM employees e JOIN publications p ON p.id=e.publication_id WHERE e.code=? ORDER BY p.collected_at DESC LIMIT 1',
        code,
      );
      assert(row, 'employee_not_found', 404);
      const timecards = db
        .all<
          Timecard & { punches: string }
        >('SELECT employee_code employeeCode,date,hours,status,punches FROM timecards WHERE publication_id=? AND employee_code=? ORDER BY date DESC', row.publication_id, code)
        .map((t) => ({ ...t, punches: JSON.parse(t.punches) as Timecard['punches'] }));
      return {
        employee: {
          code: row.code,
          name: row.name,
          department: row.department,
          position: row.position,
          station: row.station,
          active: Boolean(row.active),
        },
        timecards,
      };
    });
  }
}
export function dateInTimezone(timezone: string, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
