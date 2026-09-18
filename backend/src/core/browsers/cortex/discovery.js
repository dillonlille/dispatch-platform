// Read only station/provider metadata from Cortex's React props and, on the
// execution home, hook state. Do not select an all-DSP/all-driver filter or
// infer a tenant from delivery records.
(input) => {
  // `reason` is a fixed diagnostic label for job metrics, never page content.
  const fail = (error, reason) => ({ error, reason });
  const url = new URL(location.href);
  const request = input.request;
  if (url.origin !== input.origin || url.username || url.password)
    return fail('cortex_scope_mismatch', 'origin');
  // Without a service area Cortex redirects itineraries to its execution home,
  // which still lists the account's stations.
  const itineraries = url.pathname.startsWith('/operations/execution/itineraries');
  if (!itineraries && !/^\/operations\/execution\/?$/.test(url.pathname))
    return fail('cortex_content_incomplete', 'path');
  const token = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  const zone = (v) => new Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone;
  const stations = new Map();
  const visited = new Set();
  let reads = 0;
  let listed = 0;
  // Hook state also references DOM nodes and React internals; only plain data
  // can hold a station record, and following the rest exhausts the read budget.
  const plain = (value) => {
    const prototype = Object.getPrototypeOf(value);
    return Array.isArray(value) || !prototype || !Object.getPrototypeOf(prototype);
  };
  const inspect = (value, depth = 0, data = false) => {
    if (!value || typeof value !== 'object' || visited.has(value) || depth > 4) return;
    if (data && !plain(value)) return;
    if (++reads > 20000) throw new Error('cortex_source_too_large');
    visited.add(value);
    if (value.defaultStationCode === request.station && token(value.serviceAreaID)) {
      if (typeof value.timeZone !== 'string' || zone(value.timeZone) !== zone(request.timezone))
        throw new Error('cortex_timezone_mismatch');
      stations.set(value.serviceAreaID, value);
    }
    // A station record holds nothing else discovery needs; an account can list
    // dozens of them, so descending would spend the read budget for nothing.
    if (token(value.serviceAreaID) && 'defaultStationCode' in value) {
      listed++;
      return;
    }
    for (const [key, child] of Object.entries(value))
      if (
        !['children', 'allItinerarySummaries', 'transporterSummary', 'itineraryDetails'].includes(
          key,
        )
      )
        inspect(child, depth + 1, data);
  };
  try {
    let root;
    const seen = new Set();
    const elements = document.querySelectorAll('*');
    if (elements.length > 60000) return fail('cortex_source_too_large', 'elements');
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
        // The execution home keeps its station list in hook state, not props.
        if (!itineraries)
          for (let hook = fiber.memoizedState, n = 0; hook && n < 64; hook = hook.next, n++)
            inspect(hook.memoizedState, 1, true);
        if (props?.selectedStation && Array.isArray(props.providerFilterOptions)) root = props;
      }
    }
    if (stations.size > 1) return fail('cortex_station_unavailable', 'station_ambiguous');
    const serviceAreaId = stations.keys().next().value;
    // Cortex may not load itineraries until a service area is selected, so the
    // station alone is enough to request the scoped page for the same day.
    if (
      serviceAreaId &&
      (!itineraries ||
        url.searchParams.get('serviceAreaId') !== serviceAreaId ||
        url.searchParams.get('selectedDay') !== request.date)
    )
      return { serviceAreaId };
    if (!itineraries)
      return listed
        ? fail('cortex_station_unavailable', 'station_missing')
        : fail('cortex_content_incomplete', 'station_loading');
    if (!root)
      return fail('cortex_content_incomplete', serviceAreaId ? 'root_missing' : 'page_loading');
    if (root.isLoadingSummaries !== false)
      return fail('cortex_content_incomplete', 'summaries_loading');
    if (!serviceAreaId) return fail('cortex_station_unavailable', 'station_missing');
    if (
      root.serviceAreaId !== serviceAreaId ||
      root.selectedStation.serviceAreaID !== serviceAreaId ||
      root.selectedDay !== request.date
    )
      return { serviceAreaId };
    const options = root.providerFilterOptions.filter(
      (p) => token(p.value) && !['ALL_DSPS', 'ALL_DRIVERS'].includes(p.value),
    );
    const normalize = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');
    const names = [request.dspName, request.dspAbbreviation].map(normalize).filter(Boolean);
    const matches = options.filter((p) => names.includes(normalize(p.label)));
    const providers = new Set((matches.length ? matches : options).map((p) => p.value));
    if (providers.size !== 1)
      return fail('cortex_provider_ambiguous', providers.size ? 'provider_many' : 'provider_none');
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
    return ['cortex_source_too_large', 'cortex_timezone_mismatch'].includes(error.message)
      ? fail(error.message, 'props')
      : fail('cortex_content_incomplete', 'script_error');
  }
};
