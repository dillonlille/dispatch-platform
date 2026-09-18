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
) {
  const result = vm.runInNewContext(`(${script.trim().replace(/;$/, '')})(input)`, {
    URL,
    Intl,
    input: { origin, request },
    location: { href },
    document: {
      querySelectorAll: () => [
        { __reactFiber$fixture: { memoizedProps: root, return: { memoizedProps: extra } } },
      ],
    },
  });
  return JSON.parse(JSON.stringify(result));
}
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
