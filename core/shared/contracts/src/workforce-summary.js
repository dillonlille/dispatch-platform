'use strict';

// Summary of the normalized workforce day DTO, shared by publication and reads.
function dailySummary(rows) {
  return {
    employees: rows.length,
    activeEmployees: rows.filter(row => row.lifecycleStatus === 'active').length,
    inDayPunches: rows.reduce((total, row) => total + row.punches.inDay.length, 0),
    completeTimecards: rows.filter(row => row.condition === 'complete').length,
    needsReview: rows.filter(row => row.condition === 'needs_review').length,
    noActivity: rows.filter(row => row.condition === 'no_activity').length,
    missingOutDay: rows.filter(row => row.punches.inDay.length > 0 && row.punches.outDay.length === 0).length,
    incompleteLunch: rows.filter(row => (row.punches.outLunch.length > 0) !== (row.punches.inLunch.length > 0)).length,
    unclassifiedPunches: rows.reduce((total, row) => total + row.punches.unclassified.length, 0),
  };
}

module.exports = { dailySummary };
