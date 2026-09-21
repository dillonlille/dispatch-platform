import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockLabel,
  cortexClock,
  gapLabel,
  displayMeal,
} from '../../dashboard/src/lib/meal-breaks.js';
import type { MealEmployee } from '../../shared/contracts/meals.js';

test('meal clocks preserve local labels and distinguish repeated DST instants in details', () => {
  assert.equal(clockLabel('10:01'), '10:01 AM');
  assert.equal(clockLabel('13:05'), '1:05 PM');
  assert.equal(clockLabel('invalid'), 'invalid');
  const first = cortexClock('2026-11-01T08:30:00Z', '2026-11-01', 'America/Los_Angeles')!;
  const second = cortexClock('2026-11-01T09:30:00Z', '2026-11-01', 'America/Los_Angeles')!;
  assert.equal(first.minute, second.minute);
  assert.equal(first.label, '1:30 AM');
  assert.notEqual(first.detail, second.detail);
});

test('gap labels round upwards to seconds without deciding whether the gap exceeds the limit', () => {
  for (const [ms, label] of [
    [0, '0m'],
    [299999, '5m'],
    [300000, '5m'],
    [300001, '5m 1s'],
    [353000, '5m 53s'],
    [78000, '1m 18s'],
  ] as const)
    assert.equal(gapLabel(ms), label);
});

test('the dashboard formats server decisions without recalculating status, lateness or differences', () => {
  const row: MealEmployee = {
    id: 'e',
    name: 'Employee',
    paycom: null,
    cortex: [],
    assessment: {
      paycom: {
        inDay: { minute: 1445, day: 1 },
        outDay: null,
        lunches: [],
        events: [],
        review: false,
        legacy: false,
      },
      pairs: [
        {
          cortexIndex: null,
          lunchIndex: null,
          out: null,
          into: null,
          outDifference: 3,
          inDifference: null,
          gaps: { before: { milliseconds: 300001, overLimit: false }, after: null },
        },
      ],
      status: 'same',
      different: false,
      missing: false,
      longGap: false,
      lateIn: true,
    },
  };
  const result = displayMeal(row);
  assert.equal(result.status, 'Same times');
  assert.equal(result.lateIn, true);
  assert.equal(result.pairs[0]!.outDifference, 3);
  assert.deepEqual(result.pairs[0]!.gaps.before, {
    milliseconds: 300001,
    overLimit: false,
    label: '5m 1s',
  });
  assert.equal(result.paycom.inDay!.label, '12:05 AM');
  assert.equal(result.paycom.inDay!.detail, 'Paycom displayed time · day +1');
});
