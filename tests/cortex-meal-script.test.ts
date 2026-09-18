import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync('backend/src/core/browsers/cortex/meal.js', 'utf8');
const origin = 'https://logistics.amazon.com';
const scope = {
  date: '2026-09-15',
  station: 'DOT4',
  serviceAreaId: 'area-1',
  provider: 'provider-1',
  timezone: 'America/Los_Angeles',
};
const start = Date.parse('2026-09-15T19:00:00Z');
const summary = (progress = 1) => ({
  itineraryId: 'itinerary-1',
  transporterId: 'driver-1',
  routeCode: 'CX1',
  companyId: 'provider-1',
  executionStatus: 'IN_PROGRESS',
  stopProgress: { total: 2, completed: progress },
  latestTaskExecutionTime: start + progress,
  lastStopExecutionTime: start + progress,
  breaks: [
    {
      punchId: 'punch-1',
      breakId: 'meal-1',
      type: 'MEAL',
      state: 'ON',
      timeStampOn: start,
      timeStampOff: null,
      sequenceNumber: 1,
    },
  ],
});
const page = (day = scope.date, progress = 1) => ({
  selectedDay: day,
  serviceAreaId: 'area-1',
  selectedStation: { serviceAreaID: 'area-1', defaultStationCode: 'DOT4', timeZone: 'US/Pacific' },
  providerFilterValue: 'provider-1',
  providerFilterOptions: [{ value: 'provider-1' }],
  isLoadingSummaries: false,
  allItinerarySummaries: [summary(progress)],
  transporterSummary: { 'driver-1': { transporterName: 'Fixture Driver' } },
});
const href = (day = scope.date, detail = false) =>
  `${origin}/operations/execution/itineraries${detail ? '/itinerary-1/documentType/Itinerary' : ''}?provider=provider-1&selectedDay=${day}&serviceAreaId=area-1`;
function read(root: object, location: string, candidate?: object) {
  const result = vm.runInNewContext(`(${script.trim().replace(/;$/, '')})(input)`, {
    URL,
    Intl,
    input: { origin, scope, kind: candidate ? 'detail' : 'list', candidate },
    location: { href: location },
    document: { querySelectorAll: () => [{ __reactFiber$fixture: { memoizedProps: root } }] },
  });
  return JSON.parse(JSON.stringify(result));
}
const detail = (day: number[], progress = 1) => ({
  ...page(scope.date, progress),
  isLoadingItineraryDetails: false,
  itineraryDetails: {
    ...summary(progress),
    localDate: day,
    serviceAreaId: 'area-1',
    stops: [],
    unknownStops: [],
    inactiveTasks: [],
  },
});

test('meal collection only reads the requested day', () => {
  const [candidate] = read(page(), href()).candidates;
  assert.equal(candidate.id, 'itinerary-1');
  // Neither a URL nor a page showing another day can supply the selected date.
  assert.deepEqual(read(page('2026-09-18'), href('2026-09-18')), {
    error: 'cortex_scope_mismatch',
    reason: 'url_scope',
  });
  assert.deepEqual(read(page('2026-09-18'), href()), {
    error: 'cortex_scope_mismatch',
    reason: 'page_scope',
  });
  assert.deepEqual(read(detail([2026, 9, 18]), href(scope.date, true), candidate), {
    error: 'cortex_scope_mismatch',
    reason: 'detail_scope',
  });
  const itinerary = read(detail([2026, 9, 15]), href(scope.date, true), candidate).itinerary;
  assert.deepEqual(itinerary.meals, [
    { id: 'meal-1', start, end: null, lastDelivery: null, firstDelivery: null },
  ]);
});

test('delivery progress during a working day does not restart meal collection', () => {
  const [before] = read(page(scope.date, 1), href()).candidates;
  const [after] = read(page(scope.date, 2), href()).candidates;
  assert.equal(after.revision, before.revision);
  assert.equal(read(detail([2026, 9, 15], 2), href(scope.date, true), before).error, undefined);
  // A meal swipe is published evidence, so it still forces a fresh read.
  const ended = page(scope.date, 2);
  ended.allItinerarySummaries[0]!.breaks.push({
    ...ended.allItinerarySummaries[0]!.breaks[0]!,
    punchId: 'punch-2',
    state: 'OFF',
    timeStampOff: start + 1800000,
  } as never);
  const [swiped] = read(ended, href()).candidates;
  assert.notEqual(swiped.revision, before.revision);
  assert.deepEqual(
    read({ ...detail([2026, 9, 15], 2), ...ended }, href(scope.date, true), before),
    { error: 'cortex_source_changed', reason: 'route_changed' },
  );
});
