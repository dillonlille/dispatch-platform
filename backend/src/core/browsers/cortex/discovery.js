// Read only station/provider metadata from Cortex's React props. Do not select
// an all-DSP/all-driver filter or infer a tenant from delivery records.
(input) => {
  const fail = (error) => ({ error });
  const url = new URL(location.href);
  const request = input.request;
  if (url.origin !== input.origin || url.username || url.password)
    return fail('cortex_scope_mismatch');
  if (!url.pathname.startsWith('/operations/execution/itineraries'))
    return fail('cortex_content_incomplete');
  const token = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  const zone = (v) => new Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone;
  const stations = new Map();
  const visited = new Set();
  let reads = 0;
  const inspect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || visited.has(value) || depth > 4) return;
    if (++reads > 20000) throw new Error('cortex_source_too_large');
    visited.add(value);
    if (value.defaultStationCode === request.station && token(value.serviceAreaID)) {
      if (typeof value.timeZone !== 'string' || zone(value.timeZone) !== zone(request.timezone))
        throw new Error('cortex_timezone_mismatch');
      stations.set(value.serviceAreaID, value);
    }
    for (const [key, child] of Object.entries(value))
      if (
        !['children', 'allItinerarySummaries', 'transporterSummary', 'itineraryDetails'].includes(
          key,
        )
      )
        inspect(child, depth + 1);
  };
  try {
    let root;
    const seen = new Set();
    const elements = document.querySelectorAll('*');
    if (elements.length > 60000) return fail('cortex_source_too_large');
    for (const element of elements) {
      const key = Object.keys(element).find((k) => k.startsWith('__reactFiber'));
      for (
        let fiber = element[key], depth = 0;
        fiber && depth < 80;
        fiber = fiber.return, depth++
      ) {
        if (seen.has(fiber)) break;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        inspect(props);
        if (props?.selectedStation && Array.isArray(props.providerFilterOptions)) root = props;
      }
    }
    if (!root || root.isLoadingSummaries !== false) return fail('cortex_content_incomplete');
    if (stations.size !== 1) return fail('cortex_station_unavailable');
    const serviceAreaId = stations.keys().next().value;
    if (
      root.serviceAreaId !== serviceAreaId ||
      root.selectedStation.serviceAreaID !== serviceAreaId ||
      root.selectedDay !== request.date ||
      url.searchParams.get('serviceAreaId') !== serviceAreaId ||
      url.searchParams.get('selectedDay') !== request.date
    )
      return { serviceAreaId };
    const options = root.providerFilterOptions.filter(
      (p) => token(p.value) && !['ALL_DSPS', 'ALL_DRIVERS'].includes(p.value),
    );
    const normalize = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');
    const names = [request.dspName, request.dspAbbreviation].map(normalize).filter(Boolean);
    const matches = options.filter((p) => names.includes(normalize(p.label)));
    const providers = new Set((matches.length ? matches : options).map((p) => p.value));
    if (providers.size !== 1) return fail('cortex_provider_ambiguous');
    return {
      scope: {
        date: request.date,
        station: request.station,
        timezone: request.timezone,
        serviceAreaId,
        provider: providers.values().next().value,
      },
    };
  } catch (error) {
    return fail(
      ['cortex_source_too_large', 'cortex_timezone_mismatch'].includes(error.message)
        ? error.message
        : 'cortex_content_incomplete',
    );
  }
};
