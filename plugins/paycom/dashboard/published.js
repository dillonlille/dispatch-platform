'use strict';

const path = require('node:path');
const { openDatabase } = require('dispatch-protocol/published/database');
const { WorkforceClient } = require('dispatch-protocol/contracts/src/workforce-client');
const { DAY_SORT_KEYS: SORTS } = require('dispatch-protocol/contracts/src/workforce');
const emptySummary = () => Object.fromEntries(['employees', 'activeEmployees', 'inDayPunches', 'completeTimecards',
  'needsReview', 'noActivity', 'missingOutDay', 'incompleteLunch', 'unclassifiedPunches'].map(key => [key, 0]));

function displayEmployeeName(name, order) {
  if (order !== 'first_last' || typeof name !== 'string') return name;
  // Paycom supplies Last, First. Keep ambiguous or undelimited names intact;
  // never guess where a multiword surname, given name or suffix belongs.
  const parts = name.split(',');
  if (parts.length !== 2 || parts.some(part => !part.trim())) return name;
  return `${parts[1].trim()} ${parts[0].trim()}`;
}

class PublishedWorkforcePort {
  constructor(database, settings = {}) { this.database = database; this.settings = settings; }
  named(row) {
    return row && typeof row.employeeName === 'string'
      ? { ...row, employeeName: displayEmployeeName(row.employeeName, this.settings.name_order) } : row;
  }
  read(action) {
    const db = openDatabase(this.database);
    if (!db) return null;
    try {
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw Object.assign(new Error('schema_invalid'), { code: 'schema_invalid' });
      db.function('paycom_name', { deterministic: true }, name => displayEmployeeName(name, this.settings.name_order));
      db.function('paycom_name_search', { deterministic: true }, name => displayEmployeeName(name, this.settings.name_order)?.toLocaleLowerCase('en-US') ?? '');
      db.exec('BEGIN');
      const latest = db.prepare('SELECT * FROM periods ORDER BY target DESC LIMIT 1').get();
      const result = latest ? action(db, latest) : null;
      db.exec('COMMIT');
      return result;
    } finally { db.close(); }
  }
  snapshot() { return this.read((db, period) => JSON.parse(period.snapshot_json)); }
  page(db, table, where, parameters, order, query) {
    const total = db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get(...parameters).n;
    const items = db.prepare(`SELECT body FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...parameters, query.limit, query.offset).map(row => this.named(JSON.parse(row.body)));
    return { items, total, limit: query.limit, offset: query.offset, hasMore: query.offset + items.length < total };
  }
  employees(query) {
    return this.read((db, period) => ({ target: period.target, collectedAt: JSON.parse(period.snapshot_json).collectedAt.roster,
      ...this.page(db, 'employees', 'target=?' + (query.lifecycleStatus ? ' AND lifecycle=?' : ''),
        [period.target, ...(query.lifecycleStatus ? [query.lifecycleStatus] : [])], 'ordinal', query) }));
  }
  employee(code) {
    return this.read((db, period) => {
      const record = db.prepare('SELECT detail FROM employees WHERE target=? AND code=?').get(period.target, code);
      if (!record) return { target: period.target,
        collectedAt: JSON.parse(period.snapshot_json).collectedAt.roster, employee: null, timecard: null };
      const detail = JSON.parse(record.detail);
      return { ...detail, employee: this.named(detail.employee), timecard: this.named(detail.timecard),
        days: detail.days?.map(row => this.named(row)) };
    });
  }
  day(query) {
    return this.read((db, latest) => {
      const period = db.prepare('SELECT * FROM periods WHERE start<=? AND target>=? ORDER BY target DESC LIMIT 1').get(query.date, query.date) || latest;
      const metadata = db.prepare('SELECT summary_json FROM dates WHERE target=? AND date=?').get(period.target, query.date);
      let where = 'target=? AND date=?';
      const parameters = [period.target, query.date];
      const departments = this.settings.driver_departments;
      if (Array.isArray(departments)) {
        if (!departments.length) where += ' AND 0';
        else { where += ` AND code IN (SELECT code FROM employees WHERE target=? AND json_extract(body,'$.department.code') IN (${departments.map(()=>'?').join(',')}))`;
          parameters.push(period.target,...departments); }
      }
      for (const [field, jsonPath] of [['department','$.department.code'],['station','$.deliveryStation.code']]) if (query[field]) {
        where += ` AND code IN (SELECT code FROM employees WHERE target=? AND json_extract(body,'${jsonPath}')=?)`;
        parameters.push(period.target,query[field]);
      }
      const summary = Array.isArray(departments) || query.department || query.station
        ? require('dispatch-protocol/contracts/src/workforce-summary').dailySummary(db.prepare(`SELECT body FROM days WHERE ${where}`).all(...parameters).map(row=>JSON.parse(row.body)))
        : metadata ? JSON.parse(metadata.summary_json) : emptySummary();
      if (query.lifecycleStatus) { where += ' AND lifecycle=?'; parameters.push(query.lifecycleStatus); }
      if (query.search) {
        where += " AND (instr(search,?)>0 OR instr(paycom_name_search(json_extract(body,'$.employeeName')),?)>0)";
        const search = query.search.toLocaleLowerCase('en-US'); parameters.push(search, search);
      }
      if (query.attention === 'incomplete') where += " AND condition IN ('incomplete','needs_review')";
      else if (query.attention) { where += ' AND condition=?'; parameters.push(query.attention); }
      const direction = query.direction === 'desc' ? 'desc' : 'asc';
      const order = query.sort === 'employeeName' && this.settings.name_order === 'first_last'
        ? `paycom_name(json_extract(body,'$.employeeName')) COLLATE NOCASE ${direction},code`
        : query.sort && SORTS.includes(query.sort) ? `rank_${query.sort}_${direction}` : 'ordinal';
      return { target: period.target, businessDate: query.date, businessTimezone: period.timezone,
        periodStart: period.start, periodEnd: period.target, available: Boolean(metadata),
        collectedAt: JSON.parse(period.snapshot_json).collectedAt.timecards,
        summary,
        ...this.page(db, 'days', where, parameters, order, query) };
    });
  }
  items(kind, query) {
    return this.read((db, period) => {
      let where = 'target=? AND kind=?'; const parameters = [period.target, kind];
      if (query.lifecycleStatus) { where += ' AND lifecycle=?'; parameters.push(query.lifecycleStatus); }
      if (kind === 'punches') {
        where += ' AND date=?'; parameters.push(query.date);
        for (const [field, operator, value] of [['punch_kind', '=', query.kind], ['time', '>=', query.fromTime], ['time', '<=', query.throughTime]]) {
          if (value !== null) { where += ` AND ${field}${operator}?`; parameters.push(value); }
        }
      }
      return { target: period.target, collectedAt: JSON.parse(period.snapshot_json).collectedAt[kind === 'resourceLinks' ? 'resourceLinks' : 'timecards'],
        ...(kind === 'punches' ? { businessDate: query.date, businessTimezone: period.timezone } : {}),
        ...this.page(db, 'items', where, parameters, 'ordinal', query) };
    });
  }
  timecards(query) { return this.items('timecards', query); }
  resourceLinks(query) { return this.items('resourceLinks', query); }
  punches(query) { return this.items('punches', query); }
  settingsOptions() {
    return this.read((db,period)=>Object.fromEntries([['departments','department'],['stations','deliveryStation']].map(([key,field])=>{
      const rows=db.prepare(`SELECT json_extract(body,'$.${field}.code') value,json_extract(body,'$.${field}.name') label,count(*) count
        FROM employees WHERE target=? GROUP BY value,label ORDER BY label,value`).all(period.target);
      return [key,rows.filter(row=>typeof row.value==='string'&&typeof row.label==='string').map(row=>({...row}))];
    }))) || {departments:[],stations:[]};
  }
}
function createPublishedClient({ directory, settings = {} }) {
  const port = new PublishedWorkforcePort(path.join(directory,'paycom.sqlite3'),settings);
  return { workforce: new WorkforceClient({port}), settingsOptions:()=>port.settingsOptions() };
}
module.exports = { createPublishedClient, PublishedWorkforcePort, displayEmployeeName, SORTS };
