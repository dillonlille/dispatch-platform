'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkforceClient } = require('../src/workforce-client');
const { LocalPaycomWorkforcePort, dailyRowOrder } = require('../../../plugins/paycom/backend/adapters/workforce');

const TARGET = '2026-09-05';
const COLLECTED = '2026-08-29T06:00:00.000Z';
const BASE_URL = 'https://www.paycomonline.net/v4/cl/web.php/timecard/index';
function canonicalUrl(code) {
  const value = new URL(BASE_URL);
  value.searchParams.set('firstrefno', code);
  value.searchParams.set('perioddates', `2026-08-23_${TARGET}`);
  value.searchParams.set('formtype', 'SUMMARY');
  return value.href;
}

function employee(code = 'A001', lifecycleStatus = 'active') {
  return {
    employeeCode: code,
    employeeName: `Employee ${code}`,
    lifecycleStatus,
    isActive: lifecycleStatus !== 'inactive',
    isDriverDepartment: true,
    isDriverPosition: true,
    departmentCode: 'D1',
    departmentDesc: 'Driver',
    deliveryStationCode: 'S1',
    deliveryStationDesc: 'Station',
    positionTitle: 'Driver',
    payClass: 'PC',
    payType: 'Hourly',
    primarySupervisor: 'Supervisor',
  };
}

function rawWorkforce() {
  const employees = [employee('A001'), employee('A002', 'unknown')];
  const rosterPublication = {
    id: 'roster-private', target: TARGET, content_sha256: 'a'.repeat(64), collected_at: COLLECTED,
  };
  return {
    roster: { publication: rosterPublication, employees },
    timecards: {
      publication: {
        id: 'timecards-private', target: TARGET, collected_at: COLLECTED,
        metadata_json: JSON.stringify({ rosterPublicationId: rosterPublication.id, rosterContentSha256: rosterPublication.content_sha256 }),
      },
      rows: employees.map(row => ({
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        observedAt: COLLECTED,
        sourceSha256: 'private',
        record: {
          employeeCode: row.employeeCode,
          periodStart: '2026-08-23',
          periodEnd: TARGET,
          periodTotalHours: 8,
          days: [{
            date: '2026-08-30',
            missingPunch: row.employeeCode === 'A002',
            punches: [{
              kind: row.employeeCode === 'A001' ? 'IN DAY' : 'OUT DAY',
              displayTime: row.employeeCode === 'A001' ? '10:01 AM' : '05:00 PM',
              actualTime: row.employeeCode === 'A001' ? '10:01 AM' : '05:00 PM',
              provenanceAvailable: true,
            }],
          }],
        },
      })),
    },
    resourceLinks: {
      publication: {
        id: 'links-private', target: TARGET, collected_at: COLLECTED,
        roster_publication_id: rosterPublication.id, roster_content_sha256: rosterPublication.content_sha256,
        resource_type: 'paycom.timecard.summary', period_key: `2026-08-23_${TARGET}`,
      },
      rows: employees.map(row => ({ employeeCode: row.employeeCode, canonicalUrl: canonicalUrl(row.employeeCode) })),
    },
  };
}

function portFixture() {
  const calls = [];
  const views = rawWorkforce();
  const port = {
    snapshot: async () => ({
      target: TARGET,
      collectedAt: { roster: COLLECTED, timecards: COLLECTED, resourceLinks: COLLECTED },
      counts: { employees: 2, timecards: 2, resourceLinks: 2 },
      lifecycleCounts: { active: 1, inactive: 0, unknown: 1 },
      consistent: true,
      publicationId: 'not-forwarded',
    }),
    employees: async query => {
      calls.push(['employees', query]);
      const items = [employeeView('A002', 'unknown')];
      return { target: TARGET, collectedAt: COLLECTED, items, total: 1, limit: query.limit, offset: query.offset, hasMore: false, private: true };
    },
    employee: async code => {
      calls.push(['employee', code]);
      return {
        target: TARGET, collectedAt: COLLECTED,
        employee: employeeView(code, 'active'),
        timecard: timecardView(code, 'active'),
        private: true,
      };
    },
    timecards: async query => {
      calls.push(['timecards', query]);
      return { target: TARGET, collectedAt: COLLECTED, items: [timecardView('A001', 'active')], total: 1, limit: query.limit, offset: query.offset, hasMore: false };
    },
    punches: async query => {
      calls.push(['punches', query]);
      return {
        target: TARGET, businessDate: query.date, businessTimezone: 'America/Los_Angeles', collectedAt: COLLECTED,
        items: [{ employeeName: 'Employee A001', lifecycleStatus: 'active', date: query.date, kind: 'in_day', time: '10:01', timeBasis: 'actual', observedAt: COLLECTED }],
        total: 1, limit: query.limit, offset: query.offset, hasMore: false,
      };
    },
    day: async query => {
      calls.push(['day', query]);
      return {
        target: TARGET, businessDate: query.date, businessTimezone: 'America/Los_Angeles',
        periodStart: '2026-08-23', periodEnd: TARGET, available: true, collectedAt: COLLECTED,
        summary: {
          employees: 2, activeEmployees: 1, inDayPunches: 1, completeTimecards: 0,
          needsReview: 1, noActivity: 0, missingOutDay: 1, incompleteLunch: 0, unclassifiedPunches: 0,
        },
        items: [{
          employeeCode: 'A001', employeeName: 'Employee A001', lifecycleStatus: 'active', isDriver: true,
          department: { code: 'D1', name: 'Driver' }, deliveryStation: { code: 'S1', name: 'Station' },
          businessDate: query.date, condition: 'incomplete', missingPunch: false, totalHours: '8',
          punchCount: 1, unresolvedSlotCount: 0,
          punches: { inDay: [{ time: '10:01', timeBasis: 'actual' }], outLunch: [], inLunch: [], outDay: [], unclassified: [] },
          observedAt: COLLECTED,
        }],
        total: 1, limit: query.limit, offset: query.offset, hasMore: false,
      };
    },
    resourceLinks: async query => {
      calls.push(['resourceLinks', query]);
      return { target: TARGET, collectedAt: COLLECTED, items: [resourceLinkView('A001', 'active')], total: 1, limit: query.limit, offset: query.offset, hasMore: false };
    },
  };
  return { port, calls, views };
}

function employeeView(code, lifecycleStatus) {
  return {
    employeeCode: code, employeeName: `Employee ${code}`, lifecycleStatus, lastExplicitActive: true,
    department: { code: 'D1', name: 'Driver' }, deliveryStation: { code: 'S1', name: 'Station' },
    positionTitle: 'Driver', payClass: 'PC', payType: 'Hourly', primarySupervisor: 'Supervisor', isDriver: true,
  };
}

function timecardView(code, lifecycleStatus) {
  return {
    employeeCode: code, employeeName: `Employee ${code}`, lifecycleStatus,
    periodStart: '2026-08-23', periodEnd: TARGET, periodTotalHours: '8', missingDays: 0,
    observedAt: COLLECTED, canonicalUrl: canonicalUrl(code),
  };
}

function resourceLinkView(code, lifecycleStatus) {
  return {
    employeeCode: code, employeeName: `Employee ${code}`, lifecycleStatus,
    resourceType: 'paycom.timecard.summary', periodStart: '2026-08-23', periodEnd: TARGET,
    canonicalUrl: canonicalUrl(code),
  };
}

test('daily workforce ordering keeps no-activity employees at the bottom', () => {
  const rows = [
    { condition: 'no_activity', employeeName: 'Alpha', employeeCode: 'A001' },
    { condition: 'complete', employeeName: 'Zulu', employeeCode: 'A004' },
    { condition: 'incomplete', employeeName: 'Bravo', employeeCode: 'A002' },
    { condition: 'no_activity', employeeName: 'Charlie', employeeCode: 'A003' },
  ];
  rows.sort(dailyRowOrder);
  assert.deepEqual(rows.map(row => [row.condition, row.employeeName]), [
    ['incomplete', 'Bravo'],
    ['complete', 'Zulu'],
    ['no_activity', 'Alpha'],
    ['no_activity', 'Charlie'],
  ]);
});

test('WorkforceClient exposes closed snapshot, roster, employee, and timecard views', async () => {
  const fixture = portFixture();
  const client = new WorkforceClient({ port: fixture.port });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.data.lifecycleCounts, { active: 1, inactive: 0, unknown: 1 });
  assert.equal(JSON.stringify(snapshot).includes('publicationId'), false);

  const employees = await client.employees({ lifecycleStatus: 'unknown', limit: 10, offset: 0 });
  assert.equal(employees.data.kind, 'employees');
  assert.equal(employees.data.items[0].lifecycleStatus, 'unknown');
  assert.deepEqual(fixture.calls[0], ['employees', { lifecycleStatus: 'unknown', limit: 10, offset: 0 }]);
  assert.equal(JSON.stringify(employees).includes('private'), false);

  const detail = await client.employee('a001');
  assert.equal(detail.data.employee.employeeCode, 'A001');
  assert.equal(detail.data.timecard.periodTotalHours, '8');
  assert.deepEqual(fixture.calls[1], ['employee', 'A001']);

  const timecards = await client.timecards({ limit: 5 });
  assert.equal(timecards.data.kind, 'timecards');
  assert.equal(timecards.data.items[0].canonicalUrl.startsWith('https://'), true);
  assert.deepEqual(fixture.calls[2], ['timecards', { lifecycleStatus: null, limit: 5, offset: 0 }]);

  const punches = await client.punches({ date: '2026-08-30', kind: 'in_day', fromTime: '10:01', limit: 5 });
  assert.equal(punches.data.kind, 'punches');
  assert.equal(punches.data.items[0].employeeName, 'Employee A001');
  assert.equal(punches.data.items[0].time, '10:01');
  assert.equal(Object.hasOwn(punches.data.items[0], 'employeeCode'), false);
  assert.deepEqual(fixture.calls[3], ['punches', {
    date: '2026-08-30', kind: 'in_day', fromTime: '10:01', throughTime: null,
    lifecycleStatus: null, limit: 5, offset: 0,
  }]);

  const day = await client.day({ date: '2026-08-30', search: 'Employee', attention: 'incomplete', limit: 10 });
  assert.equal(day.data.kind, 'workforce_day');
  assert.equal(day.data.available, true);
  assert.equal(day.data.items[0].employeeCode, 'A001');
  assert.equal(day.data.items[0].punches.inDay[0].time, '10:01');
  assert.equal(day.data.summary.missingOutDay, 1);
  assert.deepEqual(fixture.calls[4], ['day', {
    date: '2026-08-30', search: 'Employee', attention: 'incomplete', lifecycleStatus: null,
    limit: 10, offset: 0,
  }]);

  const links = await client.resourceLinks({ limit: 5 });
  assert.equal(links.data.kind, 'resource_links');
  assert.equal(links.data.items[0].resourceType, 'paycom.timecard.summary');
  assert.deepEqual(fixture.calls[5], ['resourceLinks', { lifecycleStatus: null, limit: 5, offset: 0 }]);

  assert.equal((await client.employees({ extra: true })).status, 'invalid_input');
  assert.equal((await client.day({ date: 'bad' })).status, 'invalid_input');
  assert.equal((await client.employee('BAD')).status, 'invalid_input');
  const missing = new WorkforceClient({ port: {
    snapshot: async () => null, employees: async () => null, employee: async () => null,
    timecards: async () => null, punches: async () => null, day: async () => null, resourceLinks: async () => null,
  } });
  assert.equal((await missing.snapshot()).status, 'not_initialized');
});

test('WorkforceClient rejects malformed component data', async () => {
  const fixture = portFixture();
  fixture.port.employees = async query => ({
    target: TARGET, collectedAt: COLLECTED, total: 1, limit: query.limit, offset: query.offset,
    hasMore: false, items: [{ ...employeeView('A001', 'active'), employeeCode: 'BAD' }],
  });
  const result = await new WorkforceClient({ port: fixture.port }).employees();
  assert.equal(result.status, 'invalid_component_response');
});

test('LocalPaycomWorkforcePort uses one read-only store per operation and closes it', () => {
  const options = [];
  let closed = 0;
  const port = new LocalPaycomWorkforcePort({
    database: __filename,
    storeFactory: (_file, value) => {
      options.push(value);
      return { activeWorkforce: rawWorkforce, close: () => { closed += 1; } };
    },
  });
  const snapshot = port.snapshot();
  assert.deepEqual(snapshot.lifecycleCounts, { active: 1, inactive: 0, unknown: 1 });
  const unknown = port.employees({ lifecycleStatus: 'unknown', limit: 10, offset: 0 });
  assert.equal(unknown.items.length, 1);
  assert.equal(unknown.items[0].employeeCode, 'A002');
  const detail = port.employee('A001');
  assert.equal(detail.timecard.employeeCode, 'A001');
  assert.equal(detail.timecard.periodTotalHours, '8');
  const cards = port.timecards({ lifecycleStatus: null, limit: 1, offset: 1 });
  assert.equal(cards.items[0].employeeCode, 'A002');
  const punches = port.punches({
    date: '2026-08-30', kind: 'in_day', fromTime: '10:01', throughTime: null,
    lifecycleStatus: null, limit: 10, offset: 0,
  });
  assert.equal(punches.items.length, 1);
  assert.deepEqual(punches.items[0], {
    employeeName: 'Employee A001', lifecycleStatus: 'active', date: '2026-08-30',
    kind: 'in_day', time: '10:01', timeBasis: 'actual', observedAt: COLLECTED,
  });
  const day = port.day({
    date: '2026-08-30', search: null, attention: null, lifecycleStatus: null, limit: 10, offset: 0,
  });
  assert.equal(day.available, true);
  assert.equal(day.items.length, 2);
  assert.equal(day.items[0].punchCount, 1);
  assert.equal(day.summary.needsReview, 1);
  assert.equal(day.summary.missingOutDay, 1);
  const unavailable = port.day({
    date: '2026-08-01', search: null, attention: null, lifecycleStatus: null, limit: 10, offset: 0,
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.total, 0);
  const links = port.resourceLinks({ lifecycleStatus: null, limit: 1, offset: 0 });
  assert.equal(links.items[0].resourceType, 'paycom.timecard.summary');
  assert.deepEqual(options, Array.from({ length: 8 }, () => ({ readOnly: true })));
  assert.equal(closed, 8);
});

test('daily sorts span the entire roster before pagination and leave empty values last', async () => {
  const { workforceDayQuery } = require('dispatch-protocol/contracts/src/workforce');
  const { compareDailyRows } = require('../../../plugins/paycom/backend/adapters/workforce');
  const raw = rawWorkforce();
  raw.roster.employees[0].employeeName = 'Zulu';
  raw.roster.employees[1].employeeName = 'Alpha';
  const client = new WorkforceClient({ port: new LocalPaycomWorkforcePort({ database: __filename,
    storeFactory: () => ({ activeWorkforce: () => raw, close() {} }) }) });
  const asc = await client.day({ date: '2026-08-30', sort: 'employeeName', direction: 'asc', limit: 1 });
  assert.equal(asc.ok, true);
  assert.equal(asc.data.items[0].employeeName, 'Alpha');
  assert.equal(asc.data.hasMore, true);
  const desc = await client.day({ date: '2026-08-30', sort: 'employeeName', direction: 'desc', limit: 1 });
  assert.equal(desc.data.items[0].employeeName, 'Zulu');
  const base = asc.data.items[0];
  const rows = [
    { ...base, employeeName: 'Empty', totalHours: null, punches: { ...base.punches, inDay: [] } },
    { ...base, employeeName: 'Ten', totalHours: '10', punches: { ...base.punches, inDay: [{ time: '10:00' }] } },
    { ...base, employeeName: 'Two', totalHours: '2', punches: { ...base.punches, inDay: [{ time: '02:00' }] } },
  ];
  for (const key of ['totalHours', 'inDay']) {
    assert.deepEqual([...rows].sort((a,b) => compareDailyRows(a,b,key,'asc')).map(r=>r.employeeName), ['Two','Ten','Empty']);
    assert.deepEqual([...rows].sort((a,b) => compareDailyRows(a,b,key,'desc')).map(r=>r.employeeName), ['Ten','Two','Empty']);
  }
  for (const query of [{ date: '2026-02-30' }, { date: '2026-99-01' }, { date: '2026-08-30', sort: 'sourceUrl' }, { date: '2026-08-30', direction: 'random' }]) {
    assert.throws(() => workforceDayQuery(query), { code: 'invalid_input' });
  }
});

test('workforce dates use the current configured timezone and reject missing configuration', async () => {
  let timezone = 'UTC';
  const port = new LocalPaycomWorkforcePort({ database: __filename, timezone: () => timezone,
    storeFactory: () => ({ activeWorkforce: rawWorkforce, close() {} }) });
  const client = new WorkforceClient({ port });
  const query = { date: '2026-08-30', limit: 10, offset: 0 };
  assert.equal((await client.day(query)).data.businessTimezone, 'UTC');
  assert.equal(port.employee('A001').businessTimezone, 'UTC');
  assert.equal((await client.punches(query)).data.businessTimezone, 'UTC');
  timezone = 'America/New_York';
  assert.equal((await client.day(query)).data.businessTimezone, timezone);
  assert.equal(port.employee('A001').businessTimezone, timezone);
  timezone = undefined;
  assert.equal((await client.day(query)).status, 'workforce_inconsistent');
  timezone = 'invalid/timezone';
  assert.equal((await client.day(query)).status, 'workforce_inconsistent');
});

test('daily history selects the saved period and never substitutes latest-period employee rows', async () => {
  const { workforceDayQuery } = require('dispatch-protocol/contracts/src/workforce');
  const latest = rawWorkforce();
  const historical = JSON.parse(JSON.stringify(latest).replaceAll('2026-09-05','2026-08-22').replaceAll('2026-08-23','2026-08-09').replaceAll('2026-08-30','2026-08-16'));
  historical.roster.employees[0].employeeName = 'Historical employee';
  const targets = []; let closes = 0;
  const port = new LocalPaycomWorkforcePort({ database: __filename, storeFactory: () => ({
    active: (_kind, target) => target === null || target === '2026-08-22',
    activeWorkforce: target => { targets.push(target); return target === '2026-08-22' ? historical : latest; },
    close() { closes++; },
  }) });
  const day = port.day(workforceDayQuery({ date: '2026-08-16' }));
  assert.equal(day.available, true);
  assert.equal(day.items.find(row => row.employeeCode === 'A001').employeeName, 'Historical employee');
  assert.deepEqual(targets, [null,'2026-08-22']);
  assert.equal(closes, 1);
  const missing = port.day(workforceDayQuery({ date: '2026-07-01' }));
  assert.equal(missing.available, false);
  assert.deepEqual(missing.items, []);
});

test('employee timecard days cross the SDK only through the protected daily projection', async () => {
  const raw = rawWorkforce();
  raw.timecards.rows[0].record.days[0].comments = ['private comment'];
  const client = new WorkforceClient({ port: new LocalPaycomWorkforcePort({ database: __filename,
    storeFactory: () => ({ activeWorkforce: () => raw, close() {} }) }) });
  const result = await client.employee('A001');
  assert.equal(result.ok, true);
  assert.equal(result.data.days.length, 1);
  assert.equal(result.data.days[0].punches.inDay[0].time, '10:01');
  assert.equal(result.data.days[0].employeeCode, 'A001');
  assert.doesNotMatch(JSON.stringify(result), /private comment|sourceSha256|record_json|publicationId|clockName/);
});

test('an inactive employee without an active-only timecard does not break the daily page', async () => {
  const raw = rawWorkforce(); raw.roster.employees.push(employee('A003', 'inactive'));
  const client = new WorkforceClient({ port: new LocalPaycomWorkforcePort({ database: __filename,
    storeFactory: () => ({ activeWorkforce: () => raw, close() {} }) }) });
  const day = await client.day({ date: '2026-08-30', sort: 'employeeName' });
  assert.equal(day.ok, true);
  assert.equal(day.data.items.length, 2);
  const detail = await client.employee('A003');
  assert.equal(detail.ok, true);
  assert.equal(detail.data.employee.lifecycleStatus, 'inactive');
  assert.equal(detail.data.timecard, null);
  assert.deepEqual(detail.data.days, []);
});

test('an initialized empty database remains a first-collection state until publication', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { PaycomStore } = require('../../../plugins/paycom/backend/src/store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workforce-empty-'));
  const database = path.join(root, 'paycom.sqlite3');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  new PaycomStore(database).close();
  const client = new WorkforceClient({ port: new LocalPaycomWorkforcePort({ database }) });
  assert.equal((await client.employees()).status, 'not_initialized');
  assert.equal((await client.day({ date: '2026-09-08' })).status, 'not_initialized');
});
