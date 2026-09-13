'use strict';

const {
  canonicalStringify, rosterProfileSha256, rosterSummarySha256, timecardBusinessSha256,
} = require('./fingerprints');
const { TIMECARD_SUMMARY, linkRows } = require('./resource-links');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

const LIFECYCLE_STATUSES = new Set(['active', 'inactive', 'unknown']);

function employeeMap(rows, { source = false } = {}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) fail('candidate_invalid');
  const result = new Map();
  for (const row of rows) {
    if (typeof row?.employeeCode !== 'string' || !/^[A-Za-z0-9]{4}$/.test(row.employeeCode)
        || typeof row.employeeName !== 'string' || !row.employeeName.trim()
        || typeof row.isActive !== 'boolean'
        || (row.lifecycleStatus !== undefined && !LIFECYCLE_STATUSES.has(row.lifecycleStatus))) fail('candidate_invalid');
    const code = row.employeeCode.toUpperCase();
    if (result.has(code)) fail('candidate_invalid');
    const lifecycleStatus = source
      ? (row.isActive ? 'active' : 'inactive')
      : (row.lifecycleStatus || (row.isActive ? 'active' : 'inactive'));
    if (source && row.lifecycleStatus === 'unknown') fail('candidate_invalid');
    result.set(code, { ...row, employeeCode: code, lifecycleStatus });
  }
  return result;
}

function timecardMap(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) fail('candidate_invalid');
  const result = new Map();
  for (const row of rows) {
    if (typeof row?.employeeCode !== 'string' || !/^[A-Za-z0-9]{4}$/.test(row.employeeCode)
        || typeof row.employeeName !== 'string' || !row.employeeName.trim()
        || !row.record || row.record.employeeCode !== row.employeeCode) fail('candidate_invalid');
    const code = row.employeeCode.toUpperCase();
    if (result.has(code)) fail('candidate_invalid');
    result.set(code, { ...row, employeeCode: code });
  }
  return result;
}

function rowBusinessSha256(row) {
  return row.businessSha256 || timecardBusinessSha256(row.record);
}

function planWorkforceMirror({
  period,
  priorRosterRows,
  priorTimecardRows,
  sourceEmployees,
  collectedTimecardRows,
}) {
  if (!period || typeof period.key !== 'string') fail('candidate_invalid');
  const priorRoster = Array.isArray(priorRosterRows) && priorRosterRows.length === 0
    ? new Map() : employeeMap(priorRosterRows);
  const source = employeeMap(sourceEmployees, { source: true });
  const priorTimecards = timecardMap(priorTimecardRows);
  const collected = timecardMap(collectedTimecardRows);

  const merged = new Map(source);
  let retainedMissingCount = 0;
  let becameUnknownCount = 0;
  for (const [code, employee] of priorRoster) {
    if (!merged.has(code)) {
      const retained = employee.lifecycleStatus === 'inactive'
        ? employee
        : { ...employee, lifecycleStatus: 'unknown' };
      merged.set(code, retained);
      retainedMissingCount += 1;
      becameUnknownCount += Number(employee.lifecycleStatus === 'active');
    }
  }

  let rosterAddedCount = 0;
  let rosterProfileChangedCount = 0;
  let rosterSummaryChangedCount = 0;
  let rosterRecordChangedCount = 0;
  let deactivatedCount = 0;
  let reactivatedCount = 0;
  let returnedFromUnknownCount = 0;
  for (const [code, employee] of source) {
    const previous = priorRoster.get(code);
    if (!previous) {
      rosterAddedCount += 1;
      rosterRecordChangedCount += 1;
      continue;
    }
    rosterProfileChangedCount += Number(rosterProfileSha256(previous) !== rosterProfileSha256(employee));
    rosterSummaryChangedCount += Number(rosterSummarySha256(previous) !== rosterSummarySha256(employee));
    rosterRecordChangedCount += Number(canonicalStringify(previous) !== canonicalStringify(employee));
    deactivatedCount += Number(previous.lifecycleStatus === 'active' && employee.lifecycleStatus === 'inactive');
    reactivatedCount += Number(previous.lifecycleStatus === 'inactive' && employee.lifecycleStatus === 'active');
    returnedFromUnknownCount += Number(previous.lifecycleStatus === 'unknown' && employee.lifecycleStatus === 'active');
  }

  rosterRecordChangedCount += becameUnknownCount;

  const rosterRows = [...merged.values()].sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
  const activeEmployees = rosterRows.filter(row => row.isActive === true);
  if (!activeEmployees.length) fail('roster_invalid');

  const completeTimecards = new Map();
  for (const employee of activeEmployees) {
    const replacement = collected.get(employee.employeeCode);
    const retained = priorTimecards.get(employee.employeeCode);
    const row = replacement || retained;
    if (!row || row.employeeName !== employee.employeeName
        || row.record.employeeCode !== employee.employeeCode || row.record.periodEnd !== period.end) {
      fail('timecard_refresh_required');
    }
    completeTimecards.set(employee.employeeCode, row);
  }
  for (const code of collected.keys()) {
    if (!completeTimecards.has(code)) fail('membership_mismatch');
  }

  let timecardAddedCount = 0;
  let timecardChangedCount = 0;
  for (const [code, row] of collected) {
    const previous = priorTimecards.get(code);
    if (!previous) timecardAddedCount += 1;
    else timecardChangedCount += Number(rowBusinessSha256(previous) !== rowBusinessSha256(row));
  }

  const timecardRows = [...completeTimecards.values()]
    .sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
  const resourceLinkRows = linkRows(TIMECARD_SUMMARY, activeEmployees, period);
  const unknownEmployeeCount = rosterRows.filter(row => row.lifecycleStatus === 'unknown').length;
  const hasChanges = rosterRecordChangedCount > 0 || timecardAddedCount > 0 || timecardChangedCount > 0;

  return {
    hasChanges,
    absencePolicy: 'retain',
    rosterRows,
    timecardRows,
    resourceLinkRows,
    counts: {
      rosterAddedCount,
      rosterProfileChangedCount,
      rosterSummaryChangedCount,
      rosterRecordChangedCount,
      timecardAddedCount,
      timecardChangedCount,
      retainedMissingCount,
      becameUnknownCount,
      returnedFromUnknownCount,
      unknownEmployeeCount,
      deactivatedCount,
      reactivatedCount,
      activeEmployeeCount: activeEmployees.length,
    },
  };
}

module.exports = { planWorkforceMirror };
