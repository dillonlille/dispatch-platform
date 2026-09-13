'use strict';

const { success, failure } = require('./result');
const { workforceQuery, workforcePunchQuery, workforceDayQuery, workforceEmployeeCode,
  LIFECYCLE_STATUSES, PUNCH_KINDS } = require('./workforce');

const SAFE_CODES = new Set([
  'unsafe_storage', 'schema_invalid', 'not_initialized', 'roster_not_loaded',
  'workforce_inconsistent', 'publication_verification_failed',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalidComponent() {
  throw Object.assign(new Error('invalid_component_response'), { code: 'invalid_component_response' });
}
function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function text(value, max = 300) {
  if (typeof value !== 'string' || value.length > max) invalidComponent();
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) invalidComponent();
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalidComponent();
  return value;
}
function count(value) {
  if (!Number.isInteger(value) || value < 0) invalidComponent();
  return value;
}
function lifecycle(value) {
  if (!LIFECYCLE_STATUSES.includes(value)) invalidComponent();
  return value;
}
function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalidComponent();
  return value;
}
function timezone(value) {
  if (typeof value !== 'string' || value.length > 64) invalidComponent();
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); }
  catch { invalidComponent(); }
  return value;
}
function componentEmployeeCode(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{4}$/.test(value)) invalidComponent();
  return value;
}
function canonicalUrl(value, employeeCode, periodStart, periodEnd) {
  if (typeof value !== 'string' || value.length > 2048) invalidComponent();
  let url;
  try { url = new URL(value); } catch { invalidComponent(); }
  const keys = [...url.searchParams.keys()].sort();
  if (url.protocol !== 'https:' || url.hostname !== 'www.paycomonline.net' || url.port || url.username || url.password
      || url.pathname !== '/v4/cl/web.php/timecard/index' || url.hash
      || keys.join(',') !== 'firstrefno,formtype,perioddates'
      || url.searchParams.getAll('firstrefno').length !== 1 || url.searchParams.get('firstrefno') !== employeeCode
      || url.searchParams.getAll('perioddates').length !== 1 || url.searchParams.get('perioddates') !== `${periodStart}_${periodEnd}`
      || url.searchParams.getAll('formtype').length !== 1 || url.searchParams.get('formtype') !== 'SUMMARY') invalidComponent();
  return url.href;
}
function employeeView(value) {
  if (!plain(value) || typeof value.lastExplicitActive !== 'boolean' || typeof value.isDriver !== 'boolean'
      || !plain(value.department) || !plain(value.deliveryStation)) invalidComponent();
  return {
    employeeCode: componentEmployeeCode(value.employeeCode),
    employeeName: text(value.employeeName),
    lifecycleStatus: lifecycle(value.lifecycleStatus),
    lastExplicitActive: value.lastExplicitActive,
    department: { code: text(value.department.code, 128), name: text(value.department.name, 300) },
    deliveryStation: { code: text(value.deliveryStation.code, 128), name: text(value.deliveryStation.name, 300) },
    positionTitle: text(value.positionTitle),
    payClass: text(value.payClass, 128),
    payType: text(value.payType, 128),
    primarySupervisor: text(value.primarySupervisor),
    isDriver: value.isDriver,
  };
}
function timecardView(value) {
  if (!plain(value) || typeof value.periodTotalHours !== 'string') invalidComponent();
  const employeeCode = componentEmployeeCode(value.employeeCode);
  const periodStart = date(value.periodStart);
  const periodEnd = date(value.periodEnd);
  return {
    employeeCode,
    employeeName: text(value.employeeName),
    lifecycleStatus: lifecycle(value.lifecycleStatus),
    periodStart,
    periodEnd,
    periodTotalHours: value.periodTotalHours,
    missingDays: count(value.missingDays),
    observedAt: timestamp(value.observedAt),
    canonicalUrl: canonicalUrl(value.canonicalUrl, employeeCode, periodStart, periodEnd),
  };
}
function punchView(value) {
  if (!plain(value) || !PUNCH_KINDS.includes(value.kind) || !['actual', 'displayed'].includes(value.timeBasis)) invalidComponent();
  return {
    employeeName: text(value.employeeName),
    lifecycleStatus: lifecycle(value.lifecycleStatus),
    date: date(value.date),
    kind: value.kind,
    time: time(value.time),
    timeBasis: value.timeBasis,
    observedAt: timestamp(value.observedAt),
  };
}

const DAY_CONDITIONS = Object.freeze(['complete', 'incomplete', 'needs_review', 'no_activity']);
const DAY_PUNCH_KEYS = Object.freeze(['inDay', 'outLunch', 'inLunch', 'outDay', 'unclassified']);
const DAY_SUMMARY_KEYS = Object.freeze([
  'employees', 'activeEmployees', 'inDayPunches', 'completeTimecards', 'needsReview',
  'noActivity', 'missingOutDay', 'incompleteLunch', 'unclassifiedPunches',
]);

function dailyPunchView(value) {
  if (!plain(value) || !['actual', 'displayed'].includes(value.timeBasis)) invalidComponent();
  return { time: time(value.time), timeBasis: value.timeBasis };
}

function dailyRowView(value) {
  if (!plain(value) || typeof value.isDriver !== 'boolean' || typeof value.missingPunch !== 'boolean'
      || !plain(value.department) || !plain(value.deliveryStation) || !plain(value.punches)
      || !DAY_CONDITIONS.includes(value.condition) || !Number.isInteger(value.punchCount) || value.punchCount < 0
      || !Number.isInteger(value.unresolvedSlotCount) || value.unresolvedSlotCount < 0
      || value.totalHours !== null && typeof value.totalHours !== 'string') invalidComponent();
  const punches = Object.fromEntries(DAY_PUNCH_KEYS.map(key => {
    if (!Array.isArray(value.punches[key]) || value.punches[key].length > 32) invalidComponent();
    return [key, value.punches[key].map(dailyPunchView)];
  }));
  if (Object.values(punches).reduce((total, items) => total + items.length, 0) !== value.punchCount) invalidComponent();
  return {
    employeeCode: componentEmployeeCode(value.employeeCode),
    employeeName: text(value.employeeName),
    lifecycleStatus: lifecycle(value.lifecycleStatus),
    isDriver: value.isDriver,
    department: { code: text(value.department.code, 128), name: text(value.department.name, 300) },
    deliveryStation: { code: text(value.deliveryStation.code, 128), name: text(value.deliveryStation.name, 300) },
    businessDate: date(value.businessDate),
    condition: value.condition,
    missingPunch: value.missingPunch,
    totalHours: value.totalHours,
    punchCount: value.punchCount,
    unresolvedSlotCount: value.unresolvedSlotCount,
    punches,
    observedAt: timestamp(value.observedAt),
  };
}

function dailySummaryView(value) {
  if (!plain(value)) invalidComponent();
  return Object.fromEntries(DAY_SUMMARY_KEYS.map(key => [key, count(value[key])]));
}

function employeeDaysView(value, code, timecard) {
  if (!Array.isArray(value) || value.length > 14 || (timecard === null && value.length)) invalidComponent();
  const days = value.map(dailyRowView);
  if (new Set(days.map(day => day.businessDate)).size !== days.length
      || days.some(day => day.employeeCode !== code || day.businessDate < timecard.periodStart || day.businessDate > timecard.periodEnd)) invalidComponent();
  return days.sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}
function resourceLinkView(value) {
  if (!plain(value) || value.resourceType !== 'paycom.timecard.summary') invalidComponent();
  const employeeCode = componentEmployeeCode(value.employeeCode);
  const periodStart = date(value.periodStart);
  const periodEnd = date(value.periodEnd);
  return {
    employeeCode,
    employeeName: text(value.employeeName),
    lifecycleStatus: lifecycle(value.lifecycleStatus),
    resourceType: value.resourceType,
    periodStart,
    periodEnd,
    canonicalUrl: canonicalUrl(value.canonicalUrl, employeeCode, periodStart, periodEnd),
  };
}
function collectedAtView(value) {
  if (!plain(value)) invalidComponent();
  return {
    roster: timestamp(value.roster),
    timecards: timestamp(value.timecards),
    resourceLinks: timestamp(value.resourceLinks),
  };
}
function snapshotView(value) {
  if (!plain(value) || !plain(value.counts) || !plain(value.lifecycleCounts) || value.consistent !== true) invalidComponent();
  return {
    target: date(value.target),
    collectedAt: collectedAtView(value.collectedAt),
    counts: {
      employees: count(value.counts.employees),
      timecards: count(value.counts.timecards),
      resourceLinks: count(value.counts.resourceLinks),
    },
    lifecycleCounts: {
      active: count(value.lifecycleCounts.active),
      inactive: count(value.lifecycleCounts.inactive),
      unknown: count(value.lifecycleCounts.unknown),
    },
    consistent: true,
  };
}
function pageView(value, mapper) {
  if (!plain(value) || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean') invalidComponent();
  const result = {
    target: date(value.target),
    collectedAt: timestamp(value.collectedAt),
    items: value.items.map(mapper),
    total: count(value.total),
    limit: count(value.limit),
    offset: count(value.offset),
    hasMore: value.hasMore,
  };
  if (result.limit < 1 || result.limit > 100 || result.items.length > result.limit
      || result.items.length > 0 && result.offset + result.items.length > result.total
      || result.hasMore !== (result.offset + result.items.length < result.total)) invalidComponent();
  return result;
}

function punchPageView(value) {
  const page = pageView(value, punchView);
  const businessDate = date(value.businessDate);
  if (page.items.some(item => item.date !== businessDate)) invalidComponent();
  return {
    ...page,
    businessDate,
    businessTimezone: timezone(value.businessTimezone),
  };
}

function dayPageView(value) {
  if (!plain(value) || typeof value.available !== 'boolean') invalidComponent();
  const page = pageView(value, dailyRowView);
  const businessDate = date(value.businessDate);
  const periodStart = date(value.periodStart);
  const periodEnd = date(value.periodEnd);
  const summary = dailySummaryView(value.summary);
  if (periodStart > periodEnd || page.items.some(item => item.businessDate !== businessDate)
      || !value.available && (page.items.length !== 0 || page.total !== 0)
      || summary.activeEmployees > summary.employees || summary.completeTimecards > summary.employees
      || summary.needsReview > summary.employees || summary.noActivity > summary.employees) invalidComponent();
  return {
    ...page,
    businessDate,
    businessTimezone: timezone(value.businessTimezone),
    periodStart,
    periodEnd,
    available: value.available,
    summary,
  };
}

class WorkforceClient {
  #port;

  constructor({ port } = {}) {
    if (!port || ['snapshot', 'employees', 'employee', 'timecards', 'punches', 'day', 'resourceLinks'].some(method => typeof port[method] !== 'function')) {
      throw new TypeError('workforce_port_required');
    }
    this.#port = port;
  }

  async #read(operation) {
    try { return await operation(); }
    catch (error) {
      const code = error?.code === 'invalid_input' ? 'invalid_input'
        : error?.code === 'invalid_component_response' ? 'invalid_component_response'
          : SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : 'workforce_unavailable';
      return failure(code, { recoverable: ['workforce_unavailable', 'not_initialized'].includes(code) });
    }
  }

  async snapshot() {
    return this.#read(async () => {
      const value = await this.#port.snapshot();
      return value === null ? failure('not_initialized', { recoverable: true }) : success('ready', snapshotView(value));
    });
  }

  async employees(query = {}) {
    return this.#read(async () => {
      const normalized = workforceQuery(query);
      const value = await this.#port.employees(normalized);
      return value === null ? failure('not_initialized', { recoverable: true }) : success('found', { kind: 'employees', ...pageView(value, employeeView) });
    });
  }

  async employee(code) {
    return this.#read(async () => {
      const normalized = workforceEmployeeCode(code);
      const value = await this.#port.employee(normalized);
      if (value === null) return failure('not_initialized', { recoverable: true });
      if (!plain(value) || value.employee === null) return failure('employee_not_found');
      return success('found', {
        target: date(value.target),
        collectedAt: timestamp(value.collectedAt),
        employee: employeeView(value.employee),
        timecard: value.timecard === null ? null : timecardView(value.timecard),
        ...(value.days === undefined ? {} : { days: employeeDaysView(value.days, value.employee.employeeCode, value.timecard), businessTimezone: timezone(value.businessTimezone) }),
      });
    });
  }

  async timecards(query = {}) {
    return this.#read(async () => {
      const normalized = workforceQuery(query);
      const value = await this.#port.timecards(normalized);
      return value === null ? failure('not_initialized', { recoverable: true }) : success('found', { kind: 'timecards', ...pageView(value, timecardView) });
    });
  }

  async punches(query) {
    return this.#read(async () => {
      const normalized = workforcePunchQuery(query);
      const value = await this.#port.punches(normalized);
      return value === null ? failure('not_initialized', { recoverable: true })
        : success('found', { kind: 'punches', ...punchPageView(value) });
    });
  }

  async day(query) {
    return this.#read(async () => {
      const normalized = workforceDayQuery(query);
      const value = await this.#port.day(normalized);
      return value === null ? failure('not_initialized', { recoverable: true })
        : success(value.available ? 'found' : 'date_unavailable', { kind: 'workforce_day', ...dayPageView(value) });
    });
  }

  async resourceLinks(query = {}) {
    return this.#read(async () => {
      const normalized = workforceQuery(query);
      const value = await this.#port.resourceLinks(normalized);
      return value === null ? failure('not_initialized', { recoverable: true })
        : success('found', { kind: 'resource_links', ...pageView(value, resourceLinkView) });
    });
  }
}

module.exports = {
  WorkforceClient, SAFE_CODES, employeeView, timecardView, punchView, resourceLinkView, snapshotView,
  pageView, punchPageView, dailyPunchView, dailyRowView, dailySummaryView, dayPageView,
};
