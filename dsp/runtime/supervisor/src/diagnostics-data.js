'use strict';

const { periodFromEnd, buildTimecardUrl } = require('../../../plugins/paycom/backend/src/timecard-period');

const LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function timecardRecord(code = 'A001', end = '2026-09-05', variant = 1) {
  const period = periodFromEnd(end);
  return {
    version: 2,
    sourceFormat: 'paycom-timecard-dom.v2',
    employeeCode: code,
    periodStart: period.start,
    periodEnd: period.end,
    periodKey: period.key,
    sourceUrl: buildTimecardUrl(code, period, variant),
    pageTitle: 'Timecard Editor',
    headers: ['date', 'paycode', 'i1', 'allocation1', 'o1', 'i2', 'allocation2', 'o2', 'hours', 'total_hours', 'amount', 'exception-points', 'waiver', 'comment', 'missing-punch', 'delete'],
    additionalRows: [],
    periodTotalHours: 8,
    weeklyTotals: [8, 0],
    approvals: [],
    attestations: [],
    mealWaivers: [],
    days: period.dates.map((date, index) => ({
      date,
      label: LABELS[index % 7],
      payCode: '',
      allocation1: '',
      allocation2: '',
      hours: index === 0 ? 8 : null,
      totalHours: index === 0 ? 8 : null,
      dollars: null,
      exceptionText: '',
      waiverChecked: null,
      comments: [],
      missingPunch: false,
      unresolvedSlots: [],
      punches: index === 0 ? [{
        ordinal: 1, rowIndex: 0, slot: 'i1', kind: 'IN DAY', displayTime: '09:00 AM',
        actualTime: '09:00 AM', roundedTime: '09:00 AM', clockName: 'Clock', clockCode: 'WEB00',
        comment: '', provenanceAvailable: true, changeRequestStatus: null, approved: false,
        changeOperation: null, currentKind: null, currentTime: null, requestedKind: null,
        requestedTime: null, changeNote: null, changeDetailState: 'not_applicable',
      }] : [],
    })),
  };
}

function rosterRow(code = 'A001', name = 'Employee One') {
  return { employeeCode: code, employeeName: name, isActive: true, isActiveDriver: true };
}

module.exports = { timecardRecord, rosterRow };
