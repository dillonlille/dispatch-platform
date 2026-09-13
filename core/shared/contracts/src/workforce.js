'use strict';

const { exactObject, invalid, pagination } = require('./input');

const LIFECYCLE_STATUSES = Object.freeze(['active', 'inactive', 'unknown']);
const PUNCH_KINDS = Object.freeze(['in_day', 'out_lunch', 'in_lunch', 'out_day', 'unclassified']);
const DAY_ATTENTION_FILTERS = Object.freeze(['needs_review', 'incomplete', 'no_activity']);
const DAY_SORT_KEYS = Object.freeze(['employeeName', 'inDay', 'outLunch', 'inLunch', 'outDay', 'totalHours', 'condition']);
const EMPLOYEE_CODE_RE = /^[A-Za-z0-9]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function workforceQuery(value = {}) {
  exactObject(value, ['limit', 'offset', 'lifecycleStatus']);
  const page = pagination({
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
  });
  const lifecycleStatus = value.lifecycleStatus ?? null;
  if (lifecycleStatus !== null && !LIFECYCLE_STATUSES.includes(lifecycleStatus)) invalid();
  return { ...page, lifecycleStatus };
}

function workforcePunchQuery(value) {
  exactObject(value, ['date', 'kind', 'fromTime', 'throughTime', 'lifecycleStatus', 'limit', 'offset']);
  if (typeof value.date !== 'string' || !DATE_RE.test(value.date)) invalid();
  const page = pagination({
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
  });
  const kind = value.kind ?? null;
  const fromTime = value.fromTime ?? null;
  const throughTime = value.throughTime ?? null;
  const lifecycleStatus = value.lifecycleStatus ?? null;
  if (kind !== null && !PUNCH_KINDS.includes(kind)
      || fromTime !== null && (typeof fromTime !== 'string' || !TIME_RE.test(fromTime))
      || throughTime !== null && (typeof throughTime !== 'string' || !TIME_RE.test(throughTime))
      || fromTime !== null && throughTime !== null && fromTime > throughTime
      || lifecycleStatus !== null && !LIFECYCLE_STATUSES.includes(lifecycleStatus)) invalid();
  return { date: value.date, kind, fromTime, throughTime, lifecycleStatus, ...page };
}

function workforceDayQuery(value = {}) {
  exactObject(value, ['date', 'search', 'attention', 'lifecycleStatus', 'limit', 'offset', 'sort', 'direction', 'department', 'station']);
  if (typeof value.date !== 'string' || !DATE_RE.test(value.date)) invalid();
  const page = pagination({
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
  });
  const lifecycleStatus = value.lifecycleStatus ?? null;
  const attention = value.attention ?? null;
  if (value.search !== undefined && value.search !== null && typeof value.search !== 'string') invalid();
  const search = value.search === undefined || value.search === null ? null : value.search.trim();
  if (lifecycleStatus !== null && !LIFECYCLE_STATUSES.includes(lifecycleStatus)
      || attention !== null && !DAY_ATTENTION_FILTERS.includes(attention)
      || search !== null && (search.length < 1 || search.length > 100)) invalid();
  if (!Number.isFinite(Date.parse(value.date + 'T12:00:00Z')) || new Date(value.date + 'T12:00:00Z').toISOString().slice(0, 10) !== value.date) invalid();
  if (value.sort !== undefined && !DAY_SORT_KEYS.includes(value.sort)) invalid();
  if (value.direction !== undefined && !['asc', 'desc'].includes(value.direction)) invalid();
  for (const field of ['department','station']) if (value[field] !== undefined && value[field] !== null
    && (typeof value[field] !== 'string' || !value[field].length || value[field].length > 128)) invalid();
  return { date: value.date, search, attention, lifecycleStatus, ...page,
    ...(value.department === undefined ? {} : {department:value.department}),
    ...(value.station === undefined ? {} : {station:value.station}),
    ...(value.sort === undefined ? {} : { sort: value.sort }),
    ...(value.direction === undefined ? {} : { direction: value.direction }) };
}

function workforceEmployeeCode(value) {
  if (typeof value !== 'string' || !EMPLOYEE_CODE_RE.test(value)) invalid();
  return value.toUpperCase();
}

module.exports = {
  LIFECYCLE_STATUSES, PUNCH_KINDS, DAY_ATTENTION_FILTERS, DAY_SORT_KEYS, EMPLOYEE_CODE_RE, DATE_RE, TIME_RE,
  workforceQuery, workforcePunchQuery, workforceDayQuery, workforceEmployeeCode,
};
