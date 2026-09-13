'use strict';

const { timecardBusinessSha256 } = require('./fingerprints');

const PUNCH_KINDS = Object.freeze({
  'IN DAY': 'inDayCount',
  'OUT LUNCH': 'outLunchCount',
  'IN LUNCH': 'inLunchCount',
  'OUT DAY': 'outDayCount',
});
const KIND_KEYS = Object.freeze(['inDayCount', 'outLunchCount', 'inLunchCount', 'outDayCount', 'unclassifiedCount']);

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function equal(left, right) { return canonical(left) === canonical(right); }
function counts() { return Object.fromEntries(KIND_KEYS.map(key => [key, 0])); }
function kindKey(punch) { return PUNCH_KINDS[punch?.kind] || 'unclassifiedCount'; }
function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nonnegative(value) { return Number.isInteger(value) && value >= 0; }
function keyed(rows, key, code) {
  const result = new Map();
  for (const row of rows || []) {
    const value = key(row);
    if (typeof value !== 'string' || result.has(value)) throw Object.assign(new Error(code), { code });
    result.set(value, row);
  }
  return result;
}
function recordHash(row) {
  return row?.businessSha256 || timecardBusinessSha256(row?.record);
}
function punchMap(record) {
  const result = new Map();
  for (const day of record?.days || []) {
    for (const punch of day.punches || []) {
      const key = `${day.date}:${punch.rowIndex}:${punch.slot}`;
      if (result.has(key)) throw Object.assign(new Error('business_delta_invalid'), { code: 'business_delta_invalid' });
      result.set(key, punch);
    }
  }
  return result;
}
function unresolved(record) {
  const values = new Set();
  for (const day of record?.days || []) {
    for (const slot of day.unresolvedSlots || []) values.add(`${day.date}:${slot}`);
  }
  return values;
}
function intersection(left, right) { return [...left].filter(value => right.has(value)); }
function difference(left, right) { return [...left].filter(value => !right.has(value)); }

const ROSTER_KEYS = Object.freeze([
  'addedCount', 'profileChangedCount', 'summaryChangedCount', 'recordChangedCount',
  'becameUnknownCount', 'returnedFromUnknownCount',
]);
const TIMECARD_KEYS = Object.freeze(['addedCount', 'changedCount', 'unchangedCount', 'removedCount']);
const DAY_KEYS = Object.freeze([
  'addedCount', 'changedCount', 'removedCount', 'missingPunchAddedCount', 'missingPunchResolvedCount',
  'unresolvedSlotAddedCount', 'unresolvedSlotResolvedCount', 'commentSectionsChangedCount',
  'totalSectionsChangedCount',
]);
const PUNCH_KEYS = Object.freeze(['addedCount', 'editedCount', 'removedCount', 'kindChangedCount', 'addedByKind', 'removedByKind']);
const DETAIL_KEYS = Object.freeze([
  'additionalRowSectionsChangedCount', 'approvalSectionsChangedCount',
  'attestationSectionsChangedCount', 'mealWaiverSectionsChangedCount',
]);
const DELTA_KEYS = Object.freeze(['roster', 'timecards', 'days', 'punches', 'details']);

function validateKindCounts(value) {
  if (!exact(value, KIND_KEYS) || KIND_KEYS.some(key => !nonnegative(value[key]))) throw Object.assign(new Error('business_delta_invalid'), { code: 'business_delta_invalid' });
  return value;
}
function validateBusinessDelta(value) {
  if (!exact(value, DELTA_KEYS)
      || !exact(value.roster, ROSTER_KEYS) || ROSTER_KEYS.some(key => !nonnegative(value.roster[key]))
      || !exact(value.timecards, TIMECARD_KEYS) || TIMECARD_KEYS.some(key => !nonnegative(value.timecards[key]))
      || !exact(value.days, DAY_KEYS) || DAY_KEYS.some(key => !nonnegative(value.days[key]))
      || !exact(value.punches, PUNCH_KEYS)
      || ['addedCount', 'editedCount', 'removedCount', 'kindChangedCount'].some(key => !nonnegative(value.punches[key]))
      || !exact(value.details, DETAIL_KEYS) || DETAIL_KEYS.some(key => !nonnegative(value.details[key]))) {
    throw Object.assign(new Error('business_delta_invalid'), { code: 'business_delta_invalid' });
  }
  validateKindCounts(value.punches.addedByKind);
  validateKindCounts(value.punches.removedByKind);
  if (KIND_KEYS.reduce((sum, key) => sum + value.punches.addedByKind[key], 0) !== value.punches.addedCount
      || KIND_KEYS.reduce((sum, key) => sum + value.punches.removedByKind[key], 0) !== value.punches.removedCount) {
    throw Object.assign(new Error('business_delta_invalid'), { code: 'business_delta_invalid' });
  }
  return value;
}

function computeBusinessDelta(previousRows, nextRows, mirrorCounts) {
  if (!Array.isArray(previousRows) || !Array.isArray(nextRows) || !plain(mirrorCounts)) {
    throw Object.assign(new Error('business_delta_invalid'), { code: 'business_delta_invalid' });
  }
  const previous = keyed(previousRows, row => row.employeeCode, 'business_delta_invalid');
  const next = keyed(nextRows, row => row.employeeCode, 'business_delta_invalid');
  const previousCodes = new Set(previous.keys());
  const nextCodes = new Set(next.keys());
  const addedCodes = difference(nextCodes, previousCodes);
  const removedCodes = difference(previousCodes, nextCodes);
  const commonCodes = intersection(nextCodes, previousCodes);
  const changedCodes = commonCodes.filter(code => recordHash(previous.get(code)) !== recordHash(next.get(code)));
  const unchangedCodes = commonCodes.filter(code => recordHash(previous.get(code)) === recordHash(next.get(code)));
  const delta = {
    roster: {
      addedCount: mirrorCounts.rosterAddedCount,
      profileChangedCount: mirrorCounts.rosterProfileChangedCount,
      summaryChangedCount: mirrorCounts.rosterSummaryChangedCount,
      recordChangedCount: mirrorCounts.rosterRecordChangedCount,
      becameUnknownCount: mirrorCounts.becameUnknownCount,
      returnedFromUnknownCount: mirrorCounts.returnedFromUnknownCount,
    },
    timecards: {
      addedCount: addedCodes.length,
      changedCount: changedCodes.length,
      unchangedCount: unchangedCodes.length,
      removedCount: removedCodes.length,
    },
    days: {
      addedCount: 0, changedCount: 0, removedCount: 0,
      missingPunchAddedCount: 0, missingPunchResolvedCount: 0,
      unresolvedSlotAddedCount: 0, unresolvedSlotResolvedCount: 0,
      commentSectionsChangedCount: 0, totalSectionsChangedCount: 0,
    },
    punches: {
      addedCount: 0, editedCount: 0, removedCount: 0, kindChangedCount: 0,
      addedByKind: counts(), removedByKind: counts(),
    },
    details: {
      additionalRowSectionsChangedCount: 0,
      approvalSectionsChangedCount: 0,
      attestationSectionsChangedCount: 0,
      mealWaiverSectionsChangedCount: 0,
    },
  };

  for (const code of commonCodes) {
    const before = previous.get(code).record;
    const after = next.get(code).record;
    const beforeDays = keyed(before.days, day => day.date, 'business_delta_invalid');
    const afterDays = keyed(after.days, day => day.date, 'business_delta_invalid');
    const beforeDates = new Set(beforeDays.keys());
    const afterDates = new Set(afterDays.keys());
    delta.days.addedCount += difference(afterDates, beforeDates).length;
    delta.days.removedCount += difference(beforeDates, afterDates).length;
    for (const date of intersection(afterDates, beforeDates)) {
      const left = beforeDays.get(date);
      const right = afterDays.get(date);
      if (!equal(left, right)) delta.days.changedCount += 1;
      if (!left.missingPunch && right.missingPunch) delta.days.missingPunchAddedCount += 1;
      if (left.missingPunch && !right.missingPunch) delta.days.missingPunchResolvedCount += 1;
      if (!equal(left.comments, right.comments)) delta.days.commentSectionsChangedCount += 1;
      if (!equal(
        { hours: left.hours, totalHours: left.totalHours, dollars: left.dollars },
        { hours: right.hours, totalHours: right.totalHours, dollars: right.dollars },
      )) delta.days.totalSectionsChangedCount += 1;
    }
    if (!equal(before.weeklyTotals, after.weeklyTotals) || before.periodTotalHours !== after.periodTotalHours) {
      delta.days.totalSectionsChangedCount += 1;
    }
    const beforeUnresolved = unresolved(before);
    const afterUnresolved = unresolved(after);
    delta.days.unresolvedSlotAddedCount += difference(afterUnresolved, beforeUnresolved).length;
    delta.days.unresolvedSlotResolvedCount += difference(beforeUnresolved, afterUnresolved).length;

    const beforePunches = punchMap(before);
    const afterPunches = punchMap(after);
    const beforePunchKeys = new Set(beforePunches.keys());
    const afterPunchKeys = new Set(afterPunches.keys());
    for (const key of difference(afterPunchKeys, beforePunchKeys)) {
      delta.punches.addedCount += 1;
      delta.punches.addedByKind[kindKey(afterPunches.get(key))] += 1;
    }
    for (const key of difference(beforePunchKeys, afterPunchKeys)) {
      delta.punches.removedCount += 1;
      delta.punches.removedByKind[kindKey(beforePunches.get(key))] += 1;
    }
    for (const key of intersection(afterPunchKeys, beforePunchKeys)) {
      const left = beforePunches.get(key);
      const right = afterPunches.get(key);
      if (!equal(left, right)) {
        delta.punches.editedCount += 1;
        if (kindKey(left) !== kindKey(right)) delta.punches.kindChangedCount += 1;
      }
    }
    if (!equal(before.additionalRows, after.additionalRows)) delta.details.additionalRowSectionsChangedCount += 1;
    if (!equal(before.approvals, after.approvals)) delta.details.approvalSectionsChangedCount += 1;
    if (!equal(before.attestations, after.attestations)) delta.details.attestationSectionsChangedCount += 1;
    if (!equal(before.mealWaivers, after.mealWaivers)) delta.details.mealWaiverSectionsChangedCount += 1;
  }

  for (const code of addedCodes) {
    const after = next.get(code).record;
    delta.days.addedCount += after.days.length;
    for (const day of after.days) {
      delta.days.missingPunchAddedCount += Number(day.missingPunch);
      delta.days.unresolvedSlotAddedCount += day.unresolvedSlots.length;
      for (const punch of day.punches) {
        delta.punches.addedCount += 1;
        delta.punches.addedByKind[kindKey(punch)] += 1;
      }
    }
  }
  for (const code of removedCodes) {
    const before = previous.get(code).record;
    delta.days.removedCount += before.days.length;
    for (const day of before.days) {
      delta.days.missingPunchResolvedCount += Number(day.missingPunch);
      delta.days.unresolvedSlotResolvedCount += day.unresolvedSlots.length;
      for (const punch of day.punches) {
        delta.punches.removedCount += 1;
        delta.punches.removedByKind[kindKey(punch)] += 1;
      }
    }
  }
  return validateBusinessDelta(delta);
}

module.exports = {
  KIND_KEYS, ROSTER_KEYS, TIMECARD_KEYS, DAY_KEYS, PUNCH_KEYS, DETAIL_KEYS,
  validateBusinessDelta, computeBusinessDelta,
};
