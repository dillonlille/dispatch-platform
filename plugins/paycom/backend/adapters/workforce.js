'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PaycomStore } = require('../src/store');

const PUNCH_KIND_MAP = Object.freeze({
  'IN DAY': 'in_day',
  'OUT LUNCH': 'out_lunch',
  'IN LUNCH': 'in_lunch',
  'OUT DAY': 'out_day',
  '': 'unclassified',
});

function punchTime(value) {
  const match = /^(0[1-9]|1[0-2]):([0-5][0-9]) ([AP])M$/.exec(value || '');
  if (!match) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
  let hour = Number(match[1]) % 12;
  if (match[3] === 'P') hour += 12;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function lifecycleStatus(employee) {
  return employee.lifecycleStatus || (employee.isActive ? 'active' : 'inactive');
}

function employeeView(employee) {
  return {
    employeeCode: employee.employeeCode,
    employeeName: employee.employeeName,
    lifecycleStatus: lifecycleStatus(employee),
    lastExplicitActive: employee.isActive,
    department: { code: employee.departmentCode || '', name: employee.departmentDesc || '' },
    deliveryStation: { code: employee.deliveryStationCode || '', name: employee.deliveryStationDesc || '' },
    positionTitle: employee.positionTitle || '',
    payClass: employee.payClass || '',
    payType: employee.payType || '',
    primarySupervisor: employee.primarySupervisor || '',
    isDriver: employee.isDriverDepartment === true || employee.isDriverPosition === true,
  };
}

function snapshotView(workforce) {
  const employees = workforce.roster.employees;
  const lifecycleCounts = { active: 0, inactive: 0, unknown: 0 };
  for (const employee of employees) lifecycleCounts[lifecycleStatus(employee)] += 1;
  return {
    target: workforce.roster.publication.target,
    collectedAt: {
      roster: workforce.roster.publication.collected_at,
      timecards: workforce.timecards.publication.collected_at,
      resourceLinks: workforce.resourceLinks.publication.collected_at,
    },
    counts: {
      employees: employees.length,
      timecards: workforce.timecards.rows.length,
      resourceLinks: workforce.resourceLinks.rows.length,
    },
    lifecycleCounts,
    consistent: true,
  };
}

function paginate(items, query) {
  const page = items.slice(query.offset, query.offset + query.limit);
  return {
    items: page,
    total: items.length,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + page.length < items.length,
  };
}

function dailyPunch(punch) {
  const kind = PUNCH_KIND_MAP[punch.kind];
  if (!kind) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
  const actual = punch.provenanceAvailable === true && punch.actualTime;
  return {
    kind,
    time: punchTime(actual || punch.displayTime),
    timeBasis: actual ? 'actual' : 'displayed',
  };
}

function dailyRow(employee, timecard, businessDate, collectedAt) {
  const day = (timecard.record.days || []).find(item => item.date === businessDate) || null;
  const punches = {
    inDay: [], outLunch: [], inLunch: [], outDay: [], unclassified: [],
  };
  for (const punch of day?.punches || []) {
    const projected = dailyPunch(punch);
    const key = projected.kind === 'in_day' ? 'inDay'
      : projected.kind === 'out_lunch' ? 'outLunch'
        : projected.kind === 'in_lunch' ? 'inLunch'
          : projected.kind === 'out_day' ? 'outDay' : 'unclassified';
    punches[key].push({ time: projected.time, timeBasis: projected.timeBasis });
  }
  const punchCount = Object.values(punches).reduce((total, items) => total + items.length, 0);
  const needsReview = day?.missingPunch === true || punches.unclassified.length > 0;
  const condition = needsReview ? 'needs_review'
    : punchCount === 0 ? 'no_activity'
      : punches.inDay.length > 0 && punches.outDay.length > 0 ? 'complete' : 'incomplete';
  return {
    employeeCode: employee.employeeCode,
    employeeName: employee.employeeName,
    lifecycleStatus: employee.lifecycleStatus,
    isDriver: employee.isDriver,
    department: employee.department,
    deliveryStation: employee.deliveryStation,
    businessDate,
    condition,
    missingPunch: day?.missingPunch === true,
    totalHours: day?.totalHours === null || day?.totalHours === undefined ? null : String(day.totalHours),
    punchCount,
    unresolvedSlotCount: Array.isArray(day?.unresolvedSlots) ? day.unresolvedSlots.length : 0,
    punches,
    observedAt: timecard.observedAt || collectedAt,
  };
}

const { dailySummary } = require('dispatch-protocol/contracts/src/workforce-summary');

function dailyRowOrder(left, right) {
  const activityOrder = Number(left.condition === 'no_activity') - Number(right.condition === 'no_activity');
  return activityOrder || left.employeeName.localeCompare(right.employeeName)
    || left.employeeCode.localeCompare(right.employeeCode);
}

function punchStatus(row) {
  if (row.missingPunch) return 'Missing punch';
  if (row.condition === 'needs_review') return 'Needs review';
  if (row.condition === 'no_activity') return 'No punches';
  if (row.condition === 'complete') return 'Clocked out';
  if (row.punches.outLunch.length > row.punches.inLunch.length) return 'On lunch';
  return 'Clocked in';
}

// Compare the full filtered day before pagination. Empty values stay last in both directions.
function compareDailyRows(left, right, key, direction = 'asc') {
  const value = row => key === 'condition' ? punchStatus(row)
    : key === 'totalHours' ? (row.totalHours === null || row.totalHours.trim() === '' ? null : Number(row.totalHours))
      : key === 'employeeName' ? row.employeeName : row.punches[key]?.[0]?.time ?? null;
  const a = value(left), b = value(right);
  const emptyA = a === null || a === '' || typeof a === 'number' && !Number.isFinite(a);
  const emptyB = b === null || b === '' || typeof b === 'number' && !Number.isFinite(b);
  if (emptyA !== emptyB) return emptyA ? 1 : -1;
  const comparison = emptyA ? 0 : typeof a === 'number' ? a - b
    : a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
  return comparison * (direction === 'desc' ? -1 : 1)
    || left.employeeName.localeCompare(right.employeeName, 'en', { sensitivity: 'base' })
    || left.employeeCode.localeCompare(right.employeeCode);
}

function workforceViews(workforce) {
  const snapshot = snapshotView(workforce);
  const employees = workforce.roster.employees.map(employeeView);
  const employeeByCode = new Map(employees.map(employee => [employee.employeeCode, employee]));
  const linkByCode = new Map(workforce.resourceLinks.rows.map(row => [row.employeeCode, row.canonicalUrl]));
  const [periodStart, periodEnd] = workforce.resourceLinks.publication.period_key.split('_');
  const resourceLinks = workforce.resourceLinks.rows.map(row => {
    const employee = employeeByCode.get(row.employeeCode);
    if (!employee) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
    return {
      employeeCode: row.employeeCode, employeeName: employee.employeeName,
      lifecycleStatus: employee.lifecycleStatus,
      resourceType: workforce.resourceLinks.publication.resource_type,
      periodStart, periodEnd, canonicalUrl: row.canonicalUrl,
    };
  });
  const timecards = workforce.timecards.rows.map(row => {
    const employee = employeeByCode.get(row.employeeCode);
    if (!employee || !linkByCode.has(row.employeeCode)) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
    return {
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      lifecycleStatus: employee.lifecycleStatus,
      periodStart: row.record.periodStart,
      periodEnd: row.record.periodEnd,
      periodTotalHours: String(row.record.periodTotalHours),
      missingDays: row.record.days.filter(day => day.missingPunch).length,
      observedAt: row.observedAt || workforce.timecards.publication.collected_at,
      canonicalUrl: linkByCode.get(row.employeeCode),
    };
  });
  const rawTimecardByCode = new Map(workforce.timecards.rows.map(row => [row.employeeCode, row]));
  const punches = [];
  for (const row of workforce.timecards.rows) {
    const employee = employeeByCode.get(row.employeeCode);
    if (!employee) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
    for (const day of row.record.days || []) {
      for (const punch of day.punches || []) {
        const kind = PUNCH_KIND_MAP[punch.kind];
        if (!kind) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
        const actual = punch.provenanceAvailable === true && punch.actualTime;
        punches.push({
          employeeCode: row.employeeCode,
          employeeName: employee.employeeName,
          lifecycleStatus: employee.lifecycleStatus,
          date: day.date,
          kind,
          time: punchTime(actual || punch.displayTime),
          timeBasis: actual ? 'actual' : 'displayed',
          observedAt: row.observedAt || workforce.timecards.publication.collected_at,
        });
      }
    }
  }
  punches.sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time)
    || left.employeeName.localeCompare(right.employeeName) || left.employeeCode.localeCompare(right.employeeCode));
  return { snapshot, employees, employeeByCode, timecards, rawTimecardByCode, resourceLinks, punches };
}

class LocalPaycomWorkforcePort {
  #database;
  #storeFactory;
  #timezone;

  constructor({
    database = require('../src/paths').DATABASE,
    timezone = 'America/Los_Angeles',
    storeFactory = (file, options) => new PaycomStore(file, options),
  } = {}) {
    if (typeof timezone !== 'function') {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
      catch { throw new TypeError('workforce_timezone_invalid'); }
    }
    this.#database = database;
    this.#timezone = timezone;
    this.#storeFactory = storeFactory;
  }

  #businessTimezone() {
    try {
      const value = typeof this.#timezone === 'function' ? this.#timezone() : this.#timezone;
      if (typeof value !== 'string' || !value || value.length > 64) throw new Error();
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return value;
    } catch { throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' }); }
  }

  #read(target = null, businessDate = null) {
    if (!fs.existsSync(this.#database)) return null;
    let store;
    try {
      store = this.#storeFactory(this.#database, { readOnly: true });
      if (typeof store.active === 'function' && !store.active('roster', target)) return null;
      let workforce = store.activeWorkforce(target);
      if (businessDate) {
        const end = new Date(workforce.roster.publication.target + 'T12:00:00Z');
        const delta = Math.ceil((new Date(businessDate + 'T12:00:00Z') - end) / (14 * 86400000));
        end.setUTCDate(end.getUTCDate() + delta * 14);
        const selectedTarget = end.toISOString().slice(0, 10);
        if (selectedTarget !== workforce.roster.publication.target && typeof store.active === 'function' && store.active('roster', selectedTarget)) workforce = store.activeWorkforce(selectedTarget);
      }
      return workforceViews(workforce);
    } finally {
      try { store?.close(); } catch {}
    }
  }

  snapshot() {
    return this.#read()?.snapshot || null;
  }

  employees(query) {
    const value = this.#read();
    if (!value) return null;
    const items = query.lifecycleStatus === null
      ? value.employees
      : value.employees.filter(employee => employee.lifecycleStatus === query.lifecycleStatus);
    return { target: value.snapshot.target, collectedAt: value.snapshot.collectedAt.roster, ...paginate(items, query) };
  }

  employee(employeeCode) {
    const value = this.#read();
    if (!value) return null;
    const employee = value.employeeByCode.get(employeeCode);
    if (!employee) return { target: value.snapshot.target, collectedAt: value.snapshot.collectedAt.roster, employee: null, timecard: null };
    const timecard = value.timecards.find(row => row.employeeCode === employeeCode) || null;
    const raw = value.rawTimecardByCode.get(employeeCode);
    const days = raw ? raw.record.days.map(day => dailyRow(employee, raw, day.date, value.snapshot.collectedAt.timecards)) : [];
    return { target: value.snapshot.target, collectedAt: value.snapshot.collectedAt.roster, employee, timecard, days, businessTimezone: this.#businessTimezone() };
  }

  timecards(query) {
    const value = this.#read();
    if (!value) return null;
    const items = query.lifecycleStatus === null
      ? value.timecards
      : value.timecards.filter(row => row.lifecycleStatus === query.lifecycleStatus);
    return { target: value.snapshot.target, collectedAt: value.snapshot.collectedAt.timecards, ...paginate(items, query) };
  }

  punches(query) {
    const value = this.#read();
    if (!value) return null;
    let items = value.punches.filter(punch => punch.date === query.date);
    if (query.kind !== null) items = items.filter(punch => punch.kind === query.kind);
    if (query.fromTime !== null) items = items.filter(punch => punch.time >= query.fromTime);
    if (query.throughTime !== null) items = items.filter(punch => punch.time <= query.throughTime);
    if (query.lifecycleStatus !== null) items = items.filter(punch => punch.lifecycleStatus === query.lifecycleStatus);
    items = items.map(({ employeeCode: ignored, ...punch }) => punch);
    return {
      target: value.snapshot.target,
      businessDate: query.date,
      businessTimezone: this.#businessTimezone(),
      collectedAt: value.snapshot.collectedAt.timecards,
      ...paginate(items, query),
    };
  }

  day(query) {
    const value = this.#read(null, query.date);
    if (!value) return null;
    const first = value.timecards[0];
    if (!first) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
    const available = query.date >= first.periodStart && query.date <= first.periodEnd;
    let allItems = [];
    if (available) {
      allItems = value.employees.filter(employee => employee.lifecycleStatus !== 'inactive' || value.rawTimecardByCode.has(employee.employeeCode)).map(employee => {
        const timecard = value.rawTimecardByCode.get(employee.employeeCode);
        if (!timecard) throw Object.assign(new Error('workforce_inconsistent'), { code: 'workforce_inconsistent' });
        return dailyRow(employee, timecard, query.date, value.snapshot.collectedAt.timecards);
      }).sort(dailyRowOrder);
    }
    const summary = dailySummary(allItems);
    let items = allItems;
    if (query.lifecycleStatus !== null) items = items.filter(row => row.lifecycleStatus === query.lifecycleStatus);
    if (query.search !== null) {
      const search = query.search.toLocaleLowerCase('en-US');
      items = items.filter(row => row.employeeName.toLocaleLowerCase('en-US').includes(search)
        || row.employeeCode.toLocaleLowerCase('en-US').includes(search));
    }
    if (query.attention === 'needs_review') items = items.filter(row => row.condition === 'needs_review');
    if (query.attention === 'incomplete') items = items.filter(row => ['needs_review', 'incomplete'].includes(row.condition));
    if (query.attention === 'no_activity') items = items.filter(row => row.condition === 'no_activity');
    return {
      target: value.snapshot.target,
      businessDate: query.date,
      businessTimezone: this.#businessTimezone(),
      periodStart: first.periodStart,
      periodEnd: first.periodEnd,
      available,
      collectedAt: value.snapshot.collectedAt.timecards,
      summary,
      ...paginate(query.sort ? [...items].sort((a, b) => compareDailyRows(a, b, query.sort, query.direction)) : items, query),
    };
  }

  resourceLinks(query) {
    const value = this.#read();
    if (!value) return null;
    const items = query.lifecycleStatus === null
      ? value.resourceLinks
      : value.resourceLinks.filter(row => row.lifecycleStatus === query.lifecycleStatus);
    return { target: value.snapshot.target, collectedAt: value.snapshot.collectedAt.resourceLinks, ...paginate(items, query) };
  }
}

module.exports = {
  LocalPaycomWorkforcePort, lifecycleStatus, employeeView, snapshotView, paginate, workforceViews,
  compareDailyRows, punchStatus, punchTime, dailyPunch, dailyRow, dailySummary, dailyRowOrder, PUNCH_KIND_MAP,
};
