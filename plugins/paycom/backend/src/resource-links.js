'use strict';

const { canonicalTimecardUrl, parsePeriodKey, validateCode } = require('./timecard-period');

const TIMECARD_SUMMARY = 'paycom.timecard.summary';
const RESOURCE_TYPES = Object.freeze([TIMECARD_SUMMARY]);
const ROUTE_VERSION = 1;

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function buildResourceLink(resourceType, employeeCode, period) {
  if (resourceType !== TIMECARD_SUMMARY) throw new Error('resource_type_invalid');
  validateCode(employeeCode);
  return canonicalTimecardUrl(employeeCode.toUpperCase(), parsePeriodKey(period.key));
}

function isResourceLink(value, { resourceType, employeeCode, period }) {
  try {
    return typeof value === 'string'
      && value === buildResourceLink(resourceType, employeeCode, period);
  } catch {
    return false;
  }
}

function linkRows(resourceType, employees, period) {
  if (!RESOURCE_TYPES.includes(resourceType) || !Array.isArray(employees)
      || employees.length < 1 || employees.length > 5000) throw new Error('resource_links_invalid');
  const seen = new Set();
  return employees.map(employee => {
    if (!plain(employee) || typeof employee.employeeCode !== 'string'
        || !/^[A-Za-z0-9]{4}$/.test(employee.employeeCode) || employee.isActive !== true) {
      throw new Error('resource_links_invalid');
    }
    const employeeCode = employee.employeeCode.toUpperCase();
    if (seen.has(employeeCode)) throw new Error('resource_links_invalid');
    seen.add(employeeCode);
    return { employeeCode, canonicalUrl: buildResourceLink(resourceType, employeeCode, period) };
  }).sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
}

function validateResourceLinkCandidate(candidate) {
  const period = parsePeriodKey(candidate.periodKey);
  const metadataKeys = [
    'resourceType', 'periodStart', 'periodEnd', 'rosterPublicationId',
    'rosterContentSha256', 'routeVersion',
  ];
  if (candidate.target !== period.end || !exactKeys(candidate.metadata, metadataKeys)
      || !RESOURCE_TYPES.includes(candidate.metadata.resourceType)
      || candidate.metadata.periodStart !== period.start || candidate.metadata.periodEnd !== period.end
      || typeof candidate.metadata.rosterPublicationId !== 'string'
      || !/^[a-f0-9-]{36}$/.test(candidate.metadata.rosterPublicationId)
      || !/^[a-f0-9]{64}$/.test(candidate.metadata.rosterContentSha256)
      || candidate.metadata.routeVersion !== ROUTE_VERSION
      || !Array.isArray(candidate.rows) || candidate.rows.length < 1 || candidate.rows.length > 5000) {
    throw new Error('candidate_invalid');
  }
  const seen = new Set();
  for (const row of candidate.rows) {
    if (!exactKeys(row, ['employeeCode', 'canonicalUrl'])
        || typeof row.employeeCode !== 'string' || !/^[A-Z0-9]{4}$/.test(row.employeeCode)
        || seen.has(row.employeeCode)
        || !isResourceLink(row.canonicalUrl, {
          resourceType: candidate.metadata.resourceType,
          employeeCode: row.employeeCode,
          period,
        })) throw new Error('candidate_invalid');
    seen.add(row.employeeCode);
  }
  return candidate;
}

module.exports = {
  TIMECARD_SUMMARY,
  RESOURCE_TYPES,
  ROUTE_VERSION,
  buildResourceLink,
  isResourceLink,
  linkRows,
  validateResourceLinkCandidate,
};
