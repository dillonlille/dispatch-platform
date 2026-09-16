// Read only the observed Amazon application contract. No addresses, package
// references, cookies or tokens leave the page. Runs in the application's world
// because React's props are not visible from an isolated JavaScript world.
(input) => {
  const fail = (error) => ({ error });
  const scope = input.scope;
  const url = new URL(location.href);
  if (url.origin !== input.origin || url.username || url.password)
    return fail('cortex_scope_mismatch');
  if (!url.pathname.startsWith('/operations/execution/itineraries'))
    return fail('cortex_content_incomplete');
  if (
    url.searchParams.get('selectedDay') !== scope.date ||
    url.searchParams.get('serviceAreaId') !== scope.serviceAreaId ||
    url.searchParams.get('provider') !== scope.provider
  )
    return fail('cortex_scope_mismatch');
  let root;
  const seen = new Set();
  const elements = document.querySelectorAll('*');
  if (elements.length > 60000) return fail('cortex_source_too_large');
  for (const element of elements) {
    const key = Object.keys(element).find((k) => k.startsWith('__reactFiber'));
    for (let fiber = element[key], depth = 0; fiber && depth < 80; fiber = fiber.return, depth++) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (
        props &&
        Array.isArray(props.allItinerarySummaries) &&
        props.transporterSummary &&
        (input.kind === 'list' || props.itineraryDetails)
      )
        root = props;
    }
  }
  if (
    !root ||
    root.isLoadingSummaries !== false ||
    (input.kind === 'detail' && root.isLoadingItineraryDetails !== false)
  )
    return fail('cortex_content_incomplete');
  const station = root.selectedStation;
  if (
    !station ||
    root.selectedDay !== scope.date ||
    root.serviceAreaId !== scope.serviceAreaId ||
    station.serviceAreaID !== scope.serviceAreaId ||
    station.defaultStationCode !== scope.station ||
    root.providerFilterValue !== scope.provider ||
    !Array.isArray(root.providerFilterOptions) ||
    !root.providerFilterOptions.some((p) => p.value === scope.provider)
  )
    return fail('cortex_scope_mismatch');
  try {
    const zone = (value) =>
      new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    if (typeof station.timeZone !== 'string' || zone(station.timeZone) !== zone(scope.timezone))
      return fail('cortex_timezone_mismatch');
  } catch {
    return fail('cortex_timezone_mismatch');
  }
  const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:#-]{1,256}$/.test(value);
  const stamp = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.round(value < 100000000000 ? value * 1000 : value)
      : null;
  const meals = (values) => {
    if (!Array.isArray(values)) throw new Error('cortex_content_incomplete');
    return values
      .filter((b) => b.type === 'MEAL')
      .map((b) => {
        const start = stamp(b.timeStampOn),
          end = stamp(b.timeStampOff),
          id = b.punchId || b.breakId;
        if (
          !token(id) ||
          !start ||
          !['ON', 'OFF'].includes(b.state) ||
          (b.state === 'OFF' && (!end || end < start)) ||
          (b.state === 'ON' && end !== null)
        )
          throw new Error('cortex_invalid_meal_evidence');
        return { id, start, end };
      })
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  };
  try {
    const all = root.allItinerarySummaries;
    if (all.length > 1000) return fail('cortex_source_too_large');
    // Use the full loaded list, independent of visual text/progress filters.
    const selected =
      scope.provider === 'ALL_DRIVERS' ? all : all.filter((s) => s.companyId === scope.provider);
    if (scope.provider === 'ALL_DSPS') return fail('invalid_cortex_scope');
    const candidates = selected
      .map((s) => {
        const driver = root.transporterSummary[s.transporterId]?.transporterName;
        if (
          !token(s.itineraryId) ||
          !token(s.transporterId) ||
          typeof driver !== 'string' ||
          !driver.trim()
        )
          throw new Error('cortex_invalid_identity');
        const item = {
          id: s.itineraryId,
          transporterId: s.transporterId,
          driver,
          route: s.routeCode || 'UNASSIGNED',
          routeComplete: s.executionStatus === 'COMPLETE',
          meals: meals(s.breaks),
        };
        return {
          ...item,
          revision: JSON.stringify([
            item,
            s.stopProgress,
            s.latestTaskExecutionTime,
            s.lastStopExecutionTime,
          ]),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(candidates.map((c) => c.id)).size !== candidates.length)
      return fail('cortex_invalid_identity');
    if (input.kind === 'list') return { candidates };
    const c = input.candidate;
    const current = candidates.find((v) => v.id === c.id);
    if (!current || current.revision !== c.revision) return fail('cortex_source_changed');
    const d = root.itineraryDetails;
    const localDate = Array.isArray(d.localDate)
      ? d.localDate.map((v, i) => String(v).padStart(i ? 2 : 4, '0')).join('-')
      : d.localDate;
    if (
      d.itineraryId !== c.id ||
      d.transporterId !== c.transporterId ||
      d.serviceAreaId !== scope.serviceAreaId ||
      localDate !== scope.date
    )
      return fail('cortex_scope_mismatch');
    const breaks = meals(d.breaks);
    if (
      JSON.stringify(breaks.map((m) => [m.id, m.start, m.end])) !==
        JSON.stringify(c.meals.map((m) => [m.id, m.start, m.end])) ||
      (d.executionStatus === 'COMPLETE') !== c.routeComplete
    )
      return fail('cortex_source_changed');
    if (
      !Array.isArray(d.stops) ||
      !Array.isArray(d.unknownStops) ||
      !Array.isArray(d.inactiveTasks) ||
      d.stops.length > 2000
    )
      return fail('cortex_content_incomplete');
    let complete =
      d.unknownStops.length === 0 &&
      Number.isInteger(d.stopProgress?.total) &&
      d.stops.length === d.stopProgress.total;
    const eventIds = new Set(),
      stopIds = new Set(),
      deliveries = [];
    let taskCount = 0;
    for (const stop of d.stops) {
      if (!token(stop.stopId) || stopIds.has(stop.stopId) || !Array.isArray(stop.tasks))
        return fail('cortex_content_incomplete');
      stopIds.add(stop.stopId);
      for (const task of stop.tasks) {
        if (++taskCount > 10000) return fail('cortex_source_too_large');
        if (!token(task.taskId) || eventIds.has(task.taskId))
          return fail('cortex_content_incomplete');
        eventIds.add(task.taskId);
        if (task.taskState !== 'DELIVERED') continue;
        const time = stamp(task.actualExecutionTime ?? task.taskExecutionTime);
        if (
          task.taskType !== 'DROP_OFF' ||
          task.executionStatus !== 'COMPLETE' ||
          !time ||
          (task.transporterId != null && task.transporterId !== c.transporterId)
        ) {
          complete = false;
          continue;
        }
        deliveries.push({ id: task.taskId, stopId: stop.stopId, time });
      }
    }
    // A removed delivered task may affect the nearest boundary; don't guess its ownership.
    if (d.inactiveTasks.some((t) => t.taskState === 'DELIVERED')) complete = false;
    deliveries.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return {
      itinerary: {
        id: c.id,
        transporterId: c.transporterId,
        driver: c.driver,
        route: c.route,
        observedAt: Date.now(),
        routeComplete: c.routeComplete,
        deliveryCoverage: complete ? 'complete' : 'unavailable',
        meals: breaks,
        deliveries,
      },
    };
  } catch (error) {
    const allowed = [
      'cortex_content_incomplete',
      'cortex_invalid_meal_evidence',
      'cortex_invalid_identity',
    ];
    return fail(allowed.includes(error.message) ? error.message : 'cortex_content_incomplete');
  }
};
