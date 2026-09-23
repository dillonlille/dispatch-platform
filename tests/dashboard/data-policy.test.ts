import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionAffects,
  mutationAffects,
  type CollectionChange,
} from '../../dashboard/src/lib/data-policy.js';
import { sortDailyRows } from '../../dashboard/src/lib/daily-sort.js';
import type { DailyTimecard } from '../../shared/contracts/index.js';

test('a driver checkpoint touches its employee and days, not another driver, roster, or feature', () => {
  const changes: CollectionChange[] = [
    { provider: 'paycom', dates: ['2026-09-22'], employeeCode: 'A', roster: false },
  ];
  for (const url of [
    '/api/dsp/employees/A?from=2026-09-20',
    '/api/dsp/timecards?date=2026-09-22',
    '/api/dsp/paycom/meal-breaks?date=2026-09-22',
    '/api/dsp/jobs/meal-breaks?date=2026-09-22',
  ])
    assert.equal(collectionAffects(url, changes), true, url);
  for (const url of [
    '/api/dsp/employees/B',
    '/api/dsp/employees?limit=100',
    '/api/dsp/timecards?date=2026-09-21',
    '/api/dsp/members',
    '/api/platform/dsps',
  ])
    assert.equal(collectionAffects(url, changes), false, url);
  assert.equal(
    collectionAffects('/api/dsp/employees?limit=100', [{ ...changes[0]!, roster: true }]),
    true,
  );
  assert.equal(
    collectionAffects('/api/dsp/timecards?date=2026-09-22', [
      { ...changes[0]!, provider: 'cortex' },
    ]),
    false,
  );
});

test('writes invalidate their dependencies without flushing unrelated features', () => {
  assert.equal(mutationAffects('/api/dsp/paycom/settings', '/api/dsp/employees/A'), true);
  assert.equal(mutationAffects('/api/dsp/uniforms/stock/A', '/api/dsp/employees/A'), false);
  assert.equal(
    mutationAffects(
      '/api/dsp/paycom/employee-links',
      '/api/dsp/paycom/meal-breaks?date=2026-09-22',
    ),
    true,
  );
  assert.equal(mutationAffects('/api/dsp/employees/A/sync', '/api/dsp/employees/A'), true);
  assert.equal(mutationAffects('/api/dsp/employees/A/sync', '/api/dsp/employees/B'), false);
  assert.equal(mutationAffects('/api/session/dsp', '/api/platform/dsps'), false);
});

test('daily sorting is numeric and keeps ascending codes for descending ties without mutating rows', () => {
  const row = (employeeCode: string, hours: number): DailyTimecard => ({
    employeeCode,
    hours,
    name: 'Same',
    date: '2026-09-22',
    status: 'Complete',
    punches: [],
  });
  const rows = [row('B', 8), row('A', 8), row('C', 12)];
  assert.deepEqual(
    sortDailyRows(rows, 'totalHours', true).map((r) => r.employeeCode),
    ['C', 'A', 'B'],
  );
  assert.deepEqual(
    sortDailyRows(rows, 'name', true).map((r) => r.employeeCode),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(
    rows.map((r) => r.employeeCode),
    ['B', 'A', 'C'],
  );
});

test('roster changes refresh department options without treating each driver as a settings change', () => {
  const change: CollectionChange = {
    provider: 'paycom',
    dates: [],
    employeeCode: null,
    roster: true,
  };
  assert.equal(collectionAffects('/api/dsp/paycom/settings', [change]), true);
  assert.equal(
    collectionAffects('/api/dsp/paycom/settings', [{ ...change, roster: false }]),
    false,
  );
});
