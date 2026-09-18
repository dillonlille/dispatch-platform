import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync('backend/src/core/browsers/cortex/discovery.js', 'utf8');
const origin = 'https://logistics.amazon.com';
const request = {
  date: '2026-01-10',
  station: 'DOT4',
  timezone: 'America/Los_Angeles',
  dspName: 'Full Scale Logistics',
  dspAbbreviation: 'FSCL',
};
const station = { serviceAreaID: 'area-1', defaultStationCode: 'DOT4', timeZone: 'US/Pacific' };
const props = () => ({
  selectedStation: station,
  selectedDay: request.date,
  serviceAreaId: 'area-1',
  isLoadingSummaries: false,
  providerFilterOptions: [
    { value: 'ALL_DRIVERS', label: 'All Drivers' },
    { value: 'ALL_DSPS', label: 'All DSPs' },
    { value: 'provider-1', label: 'FSCL' },
    { value: 'provider-2', label: 'Other DSP' },
  ],
});
function discover(
  root: object,
  href = `${origin}/operations/execution/itineraries?selectedDay=${request.date}&serviceAreaId=area-1`,
  extra = {},
  memoizedState: unknown = null,
) {
  const result = vm.runInNewContext(`(${script.trim().replace(/;$/, '')})(input)`, {
    URL,
    Intl,
    input: { origin, request },
    location: { href },
    document: {
      querySelectorAll: () => [
        {
          __reactFiber$fixture: {
            memoizedProps: root,
            memoizedState,
            return: { memoizedProps: extra },
          },
        },
      ],
    },
  });
  return JSON.parse(JSON.stringify(result));
}
// Cortex's execution home keeps its service areas in a hook ref, after hooks
// that reference DOM nodes and other React internals.
const home = `${origin}/operations/execution/`;
const hooks = (...values: unknown[]) =>
  values.reduceRight<unknown>((next, memoizedState) => ({ memoizedState, next }), null);
test('first-use discovery matches the DSP in a station with multiple providers', () => {
  assert.deepEqual(discover(props()), {
    scope: {
      date: request.date,
      station: 'DOT4',
      timezone: request.timezone,
      serviceAreaId: 'area-1',
      provider: 'provider-1',
    },
  });
  assert.equal(
    discover({ ...props(), providerFilterOptions: [{ value: 'provider-1' }] }).scope.provider,
    'provider-1',
  );
  assert.equal(
    discover({
      ...props(),
      providerFilterOptions: [
        { value: 'provider-1', label: ' full scale logistics ' },
        { value: 'provider-2' },
      ],
    }).scope.provider,
    'provider-1',
  );
});
test('discovery can navigate from a different station using available station metadata', () => {
  const root = {
    ...props(),
    serviceAreaId: 'other',
    selectedStation: { ...station, defaultStationCode: 'ABC1', serviceAreaID: 'other' },
  };
  assert.deepEqual(discover(root, undefined, { stations: [root.selectedStation, station] }), {
    serviceAreaId: 'area-1',
  });
  assert.deepEqual(
    discover(props(), `${origin}/operations/execution/itineraries?selectedDay=${request.date}`),
    { serviceAreaId: 'area-1' },
  );
  assert.equal(discover(root).error, 'cortex_station_unavailable');
});
test('discovery rejects ambiguous DSPs, all-provider filters, wrong origins and mismatched timezones', () => {
  for (const providerFilterOptions of [
    [],
    [{ value: 'ALL_DSPS' }],
    [{ value: 'ALL_DRIVERS' }],
    [{ value: 'provider-2' }, { value: 'provider-3' }],
    [
      { value: 'provider-1', label: 'FSCL' },
      { value: 'provider-2', label: 'FSCL' },
    ],
  ]) {
    assert.equal(
      discover({ ...props(), providerFilterOptions }).error,
      'cortex_provider_ambiguous',
    );
  }
  assert.equal(
    discover(props(), 'https://other.example/operations/execution/itineraries').error,
    'cortex_scope_mismatch',
  );
  assert.equal(
    discover({ ...props(), selectedStation: { ...station, timeZone: 'America/New_York' } }).error,
    'cortex_timezone_mismatch',
  );
  assert.equal(
    discover({ ...props(), isLoadingSummaries: true }).error,
    'cortex_content_incomplete',
  );
  assert.equal(
    discover(props(), undefined, { stations: [{ ...station, serviceAreaID: 'conflicting' }] })
      .error,
    'cortex_station_unavailable',
  );
});
test('first-use discovery finds the station on the execution home Cortex redirects to', () => {
  class Internal {
    get stations(): never {
      throw new Error('React internals must not be read');
    }
  }
  const other = { ...station, serviceAreaID: 'area-2', defaultStationCode: 'ABC1' };
  const state = hooks(new Internal(), 'text', {
    current: { 'area-2': other, 'area-1': { ...station, nested: new Internal() } },
  });
  assert.deepEqual(discover({}, home, {}, state), { serviceAreaId: 'area-1' });
  assert.deepEqual(discover({}, `${origin}/operations/execution`, {}, state), {
    serviceAreaId: 'area-1',
  });
  assert.deepEqual(discover({}, home, {}, hooks({ current: {} })), {
    error: 'cortex_content_incomplete',
    reason: 'station_loading',
  });
  assert.deepEqual(discover({}, home, {}, hooks({ current: { 'area-2': other } })), {
    error: 'cortex_station_unavailable',
    reason: 'station_missing',
  });
  assert.deepEqual(
    discover(
      {},
      home,
      {},
      hooks({ current: { a: station, b: { ...station, serviceAreaID: 'b' } } }),
    ),
    { error: 'cortex_station_unavailable', reason: 'station_ambiguous' },
  );
  assert.equal(
    discover({}, home, {}, hooks({ current: { a: { ...station, timeZone: 'America/New_York' } } }))
      .error,
    'cortex_timezone_mismatch',
  );
  // Hook state is only read on the execution home, and no other page is trusted.
  assert.equal(discover({}, undefined, {}, state).reason, 'page_loading');
  for (const path of ['/dspconsolev2', '/operations/execution/other', '/operations/planning/'])
    assert.deepEqual(discover(props(), `${origin}${path}`, {}, state), {
      error: 'cortex_content_incomplete',
      reason: 'path',
    });
});
test('discovery only resolves a scope for the requested day', () => {
  const scoped = (day: string) =>
    `${origin}/operations/execution/itineraries?selectedDay=${day}&serviceAreaId=area-1`;
  // A page showing another day is sent back to the requested day, never published.
  assert.deepEqual(discover(props(), scoped('2026-01-09')), { serviceAreaId: 'area-1' });
  assert.deepEqual(discover({ ...props(), selectedDay: '2026-01-09' }), {
    serviceAreaId: 'area-1',
  });
  assert.equal(discover(props(), scoped(request.date)).scope.date, request.date);
});
test('discovery reports why a page is not ready', () => {
  assert.equal(discover({ ...props(), isLoadingSummaries: true }).reason, 'summaries_loading');
  assert.equal(discover({}).reason, 'page_loading');
  assert.equal(discover({ ...props(), providerFilterOptions: [] }).reason, 'provider_none');
  assert.equal(
    discover({ ...props(), providerFilterOptions: [{ value: 'a' }, { value: 'b' }] }).reason,
    'provider_many',
  );
});
