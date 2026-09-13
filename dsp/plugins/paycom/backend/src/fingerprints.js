'use strict';

const crypto = require('node:crypto');
const { canonicalTimecardUrl, parsePeriodKey } = require('./timecard-period');

const PROFILE_FIELDS = Object.freeze([
  'employeeCode', 'employeeName', 'status', 'lifecycleStatus',
  'departmentCode', 'departmentDesc', 'deliveryStationCode', 'deliveryStationDesc',
  'positionTitle', 'payClass', 'terminalGroup', 'payType', 'primarySupervisor',
  'isActive', 'isDriverDepartment', 'isDriverPosition', 'isActiveDriver',
]);
const SUMMARY_FIELDS = Object.freeze([
  'missingPunches', 'totalHours', 'totalOvertimeHours',
  'employeeApprovalPercentage', 'supervisorApprovalPercentage',
]);

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalStringify(value))).digest('hex');
}

function projection(value, fields) {
  return Object.fromEntries(fields.map(field => [field, Object.hasOwn(value, field) ? value[field] : null]));
}

function rosterProfileSha256(employee) {
  if (!plain(employee)) throw new Error('api_invalid');
  return sha256(projection(employee, PROFILE_FIELDS));
}

function rosterSummarySha256(employee) {
  if (!plain(employee)) throw new Error('api_invalid');
  return sha256(projection(employee, SUMMARY_FIELDS));
}

function canonicalBusinessTimecard(record) {
  if (!plain(record) || typeof record.employeeCode !== 'string' || typeof record.periodKey !== 'string') {
    throw new Error('timecard_identity_invalid');
  }
  const period = parsePeriodKey(record.periodKey);
  return { ...record, sourceUrl: canonicalTimecardUrl(record.employeeCode, period) };
}

function timecardBusinessSha256(record) {
  return sha256(canonicalBusinessTimecard(record));
}

module.exports = {
  PROFILE_FIELDS,
  SUMMARY_FIELDS,
  canonicalStringify,
  canonicalBusinessTimecard,
  rosterProfileSha256,
  rosterSummarySha256,
  timecardBusinessSha256,
};
