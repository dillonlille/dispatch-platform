'use strict';

const fs = require('node:fs');
const { openDatabase, transaction } = require('dispatch-protocol/published/database');
const { PaycomStore } = require('../src/store');
const { workforceViews, dailyRow, dailyRowOrder, dailySummary, compareDailyRows } = require('./workforce');
const { DAY_SORT_KEYS: SORTS } = require('dispatch-protocol/contracts/src/workforce');

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS periods(target TEXT PRIMARY KEY,start TEXT NOT NULL,timezone TEXT NOT NULL,fingerprint TEXT NOT NULL,snapshot_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS employees(target TEXT NOT NULL REFERENCES periods(target) ON DELETE CASCADE,code TEXT NOT NULL,ordinal INTEGER NOT NULL,lifecycle TEXT NOT NULL,body TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(target,code));
    CREATE INDEX IF NOT EXISTS employees_page ON employees(target,lifecycle,ordinal);
    CREATE TABLE IF NOT EXISTS dates(target TEXT NOT NULL REFERENCES periods(target) ON DELETE CASCADE,date TEXT NOT NULL,summary_json TEXT NOT NULL,PRIMARY KEY(target,date));
    CREATE TABLE IF NOT EXISTS days(target TEXT NOT NULL REFERENCES periods(target) ON DELETE CASCADE,date TEXT NOT NULL,code TEXT NOT NULL,ordinal INTEGER NOT NULL,lifecycle TEXT NOT NULL,condition TEXT NOT NULL,search TEXT NOT NULL,body TEXT NOT NULL,
      ${SORTS.flatMap(key => ['asc', 'desc'].map(direction => `rank_${key}_${direction} INTEGER NOT NULL`)).join(',')},PRIMARY KEY(target,date,code));
    CREATE INDEX IF NOT EXISTS days_page ON days(target,date,ordinal);
    CREATE TABLE IF NOT EXISTS items(target TEXT NOT NULL REFERENCES periods(target) ON DELETE CASCADE,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,lifecycle TEXT NOT NULL,date TEXT,punch_kind TEXT,time TEXT,body TEXT NOT NULL,PRIMARY KEY(target,kind,ordinal));
    CREATE INDEX IF NOT EXISTS items_page ON items(target,kind,lifecycle,date,ordinal);
    PRAGMA user_version=1;`);
  for (const key of SORTS) for (const direction of ['asc', 'desc']) {
    db.exec(`CREATE INDEX IF NOT EXISTS days_${key}_${direction} ON days(target,date,rank_${key}_${direction});`);
  }
}

function publishPeriod(db, raw, timezone) {
  const views = workforceViews(raw);
  const fingerprint = [raw.roster.publication.id, raw.timecards.publication.id, raw.resourceLinks.publication.id, timezone].join(':');
  const target = views.snapshot.target;
  if (db.prepare('SELECT fingerprint FROM periods WHERE target=?').get(target)?.fingerprint === fingerprint) return false;
  const period = views.timecards[0];
  if (!period) throw new Error('workforce_inconsistent');
  transaction(db, () => {
    db.prepare('DELETE FROM periods WHERE target=?').run(target);
    db.prepare('INSERT INTO periods VALUES(?,?,?,?,?)').run(target, period.periodStart, timezone, fingerprint, JSON.stringify(views.snapshot));
    const employeeInsert = db.prepare('INSERT INTO employees VALUES(?,?,?,?,?,?)');
    const timecardByCode = new Map(views.timecards.map(item => [item.employeeCode, item]));
    for (const [ordinal, employee] of views.employees.entries()) {
      const timecard = timecardByCode.get(employee.employeeCode) || null;
      const record = views.rawTimecardByCode.get(employee.employeeCode);
      const detail = { target, collectedAt: views.snapshot.collectedAt.roster, employee, timecard,
        days: record ? record.record.days.map(day => dailyRow(employee, record, day.date, views.snapshot.collectedAt.timecards)) : [], businessTimezone: timezone };
      employeeInsert.run(target, employee.employeeCode, ordinal, employee.lifecycleStatus, JSON.stringify(employee), JSON.stringify(detail));
    }
    const rowInsert = db.prepare(`INSERT INTO days VALUES(${Array(8 + SORTS.length * 2).fill('?').join(',')})`);
    const dates = [];
    for (let date = new Date(period.periodStart + 'T12:00:00Z'); date.toISOString().slice(0, 10) <= target; date.setUTCDate(date.getUTCDate() + 1)) dates.push(date.toISOString().slice(0, 10));
    if (dates.length !== 14) throw new Error('workforce_inconsistent');
    for (const date of dates) {
      const rows = views.employees.filter(item => item.lifecycleStatus !== 'inactive' || views.rawTimecardByCode.has(item.employeeCode))
        .map(employee => dailyRow(employee, views.rawTimecardByCode.get(employee.employeeCode), date, views.snapshot.collectedAt.timecards)).sort(dailyRowOrder);
      db.prepare('INSERT INTO dates VALUES(?,?,?)').run(target, date, JSON.stringify(dailySummary(rows)));
      const ranks = SORTS.flatMap(key => ['asc', 'desc'].map(direction => new Map([...rows].sort((a, b) => compareDailyRows(a, b, key, direction)).map((row, index) => [row.employeeCode, index]))));
      for (const [ordinal, row] of rows.entries()) rowInsert.run(target, date, row.employeeCode, ordinal, row.lifecycleStatus, row.condition,
        `${row.employeeName}\n${row.employeeCode}`.toLocaleLowerCase('en-US'), JSON.stringify(row), ...ranks.map(rank => rank.get(row.employeeCode)));
    }
    const insert = db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?)');
    for (const kind of ['timecards', 'resourceLinks', 'punches']) for (const [ordinal, item] of views[kind].entries()) {
      const { employeeCode: ignored, ...punch } = item;
      insert.run(target, kind, ordinal, item.lifecycleStatus, item.date || null, item.kind || null, item.time || null, JSON.stringify(kind === 'punches' ? punch : item));
    }
  });
  return true;
}

// Runs inside the DSP. Only changed complete periods are rebuilt; retained
// periods remain queryable. Publication failure cannot replace the prior data.
async function publishWorkforce({ database, publishedDatabase, timezone }) {
  if (!fs.existsSync(database)) return { changed: 0 };
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  const store = new PaycomStore(database, { readOnly: true });
  let db; let changed = 0;
  try {
    // Read workers mount this projection read-only. Rollback journaling keeps
    // reads independent of writable WAL/shared-memory sidecars after a restart.
    db = openDatabase(publishedDatabase, { write: true, journalMode: 'DELETE' }); schema(db);
    const pointers = store.db.prepare(`SELECT r.target,r.publication_id roster,t.publication_id timecards,l.publication_id links
      FROM active_publications r JOIN active_publications t ON t.kind='timecards' AND t.target=r.target
      JOIN active_resource_link_publications l ON l.target=r.target
      WHERE r.kind='roster' ORDER BY r.target`).all();
    for (const row of pointers) {
      const fingerprint = [row.roster, row.timecards, row.links, timezone].join(':');
      if (db.prepare('SELECT fingerprint FROM periods WHERE target=?').get(row.target)?.fingerprint === fingerprint) continue;
      // A collection may be between independent first-publication steps.
      // Inconsistent periods are not exposed and will be retried next time.
      let raw;
      try { raw = store.activeWorkforce(row.target); }
      catch (error) { if (error.message === 'workforce_inconsistent') continue; throw error; }
      if (publishPeriod(db, raw, timezone)) changed++;
      await new Promise(resolve => setImmediate(resolve));
    }
    return { changed };
  } finally { db?.close(); store.close(); }
}
module.exports = { publishWorkforce, publishPeriod, schema };
