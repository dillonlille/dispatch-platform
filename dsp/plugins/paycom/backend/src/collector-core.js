'use strict';

const fs = require('node:fs');
const { collectRoster, collectTimecards } = require('./browser');
const { parseRosterSource } = require('./roster-parser');
const { ANCHOR_START, periodContaining, periodFromEnd, previousPeriod, nextPeriod } = require('./timecard-period');
const { PaycomStore, stageCandidate, cleanupStage, cleanupRunStages } = require('./store');
const { TIMECARD_SUMMARY, RESOURCE_TYPES, ROUTE_VERSION, linkRows } = require('./resource-links');
const { planWorkforceMirror } = require('./sync-publication');

const METHODS = new Set([
  'collection.resolve-targets',
  'collector.health', 'pay-periods.discover', 'roster.snapshot', 'roster.period',
  'resource-links.current-period', 'resource-links.period', 'resource-links.audit',
  'timecards.current-period', 'timecards.period', 'timecards.from-published-roster', 'timecards.audit', 'timecards.incremental',
  'reconcile.current-period', 'sync.current-workforce',
]);
const SAFE_ERRORS = new Set([
  'invalid_request', 'deadline_exceeded', 'profile_not_configured', 'profile_locked', 'session_busy',
  'adapter_unavailable', 'browser_unavailable', 'unsafe_browser', 'browser_start_failed', 'browser_profile_busy',
  'browser_protocol_failed', 'browser_timeout',
  'authentication_timeout', 'primary_credentials_rejected', 'security_answers_rejected', 'invalid_credentials', 'account_locked', 'manual_verification_required',
  'authentication_failed', 'acquisition_cancelled', 'broker_closing', 'broker_unavailable',
  'attempt_cooldown', 'attempt_state_invalid', 'session_revoked',
  'lease_not_found', 'lease_not_ready', 'browser_lost', 'browser_cleanup_failed',
  'paycom_page_unavailable', 'cdp_invalid_targets', 'navigation_failed', 'navigation_policy_violation',
  'paycom_timeout', 'roster_request_timeout', 'roster_response_timeout', 'roster_loading_timeout',
  'roster_request_url_mismatch', 'roster_response_invalid', 'roster_period_mismatch', 'roster_body_unavailable',
  'roster_membership_mismatch', 'roster_source_not_authoritative',
  'roster_filter_search', 'roster_filter_advanced_null', 'roster_filter_advanced_enabled',
  'roster_filter_advanced_invalid', 'roster_filter_borrowed', 'roster_filter_pay_class',
  'roster_filter_earnings', 'roster_filter_approval', 'roster_filter_page_offset',
  'roster_filter_page_size', 'roster_filter_count',
  'api_invalid', 'csv_invalid', 'roster_not_loaded', 'roster_invalid',
  'timecards_not_loaded', 'timecards_invalid', 'timecard_body_unavailable', 'timecard_html_invalid',
  'timecard_page_timeout', 'timecard_item_timeout', 'candidate_invalid', 'candidate_too_large', 'unsafe_storage',
  'publication_verification_failed', 'publication_base_changed', 'business_delta_invalid', 'business_date_changed',
  'stage_cleanup_failed', 'integrity_failed', 'membership_mismatch',
  'stale_collection_attempt', 'invalid_period', 'invalid_employee_code', 'invalid_collection',
  'resource_type_invalid', 'resource_links_invalid',
]);

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, allowed, required = allowed) {
  return plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function dateInTimezone(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function validateRequest(value) {
  if (!exactKeys(value, ['protocolVersion', 'runId', 'plan', 'source', 'method', 'input', 'attempt', 'deadline'])
      || value.protocolVersion !== 1 || typeof value.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.runId)
      || typeof value.plan !== 'string' || !METHODS.has(value.method) || !plain(value.input)
      || !Number.isInteger(value.attempt) || value.attempt < 1 || typeof value.deadline !== 'string' || Number.isNaN(Date.parse(value.deadline))
      || !exactKeys(value.source, ['id', 'collector', 'authProfile', 'config']) || value.source.collector !== 'paycom'
      || typeof value.source.id !== 'string' || typeof value.source.authProfile !== 'string' || !plain(value.source.config)
      || !exactKeys(value.source.config, ['timezone', 'maxConcurrency'])
      || typeof value.source.config.timezone !== 'string' || value.source.config.timezone.length > 64
      || !Number.isInteger(value.source.config.maxConcurrency) || value.source.config.maxConcurrency < 1 || value.source.config.maxConcurrency > 6) fail('invalid_request');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.source.config.timezone }).format(); } catch { fail('invalid_request'); }
  const schemas = {
    'collection.resolve-targets': [['selectorKind', 'date', 'start', 'end', 'key'], ['selectorKind']],
    'collector.health': [[], []],
    'pay-periods.discover': [[], []],
    'roster.snapshot': [[], []],
    'roster.period': [['periodEnd'], ['periodEnd']],
    'resource-links.current-period': [['resourceType'], ['resourceType']],
    'resource-links.period': [['resourceType', 'periodEnd'], ['resourceType', 'periodEnd']],
    'resource-links.audit': [['resourceType', 'periodEnd'], ['resourceType']],
    'timecards.current-period': [[], []],
    'timecards.period': [['periodEnd'], ['periodEnd']],
    'timecards.from-published-roster': [['periodEnd'], ['periodEnd']],
    'timecards.audit': [['periodEnd'], ['periodEnd']],
    'timecards.incremental': [[], []],
    'reconcile.current-period': [[], []],
    'sync.current-workforce': [
      ['reconcileBatchSize', 'fullReconcileMinutes', 'lookbackPeriods', 'publishMode'],
      ['reconcileBatchSize', 'fullReconcileMinutes', 'lookbackPeriods'],
    ],
  };
  const [allowed, required] = schemas[value.method];
  if (!exactKeys(value.input, allowed, required)) fail('invalid_request');
  if ('periodEnd' in value.input && (typeof value.input.periodEnd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.input.periodEnd))) fail('invalid_request');
  if ('resourceType' in value.input && !RESOURCE_TYPES.includes(value.input.resourceType)) fail('invalid_request');
  if (value.method === 'sync.current-workforce') {
    const ranges = {
      reconcileBatchSize: [1, 500],
      fullReconcileMinutes: [60, 10_080],
      lookbackPeriods: [1, 1],
    };
    for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
      if (!Number.isInteger(value.input[key]) || value.input[key] < minimum || value.input[key] > maximum) fail('invalid_request');
    }
    if ('publishMode' in value.input && !['shadow', 'additions_edits_preview', 'additions_edits'].includes(value.input.publishMode)) fail('invalid_request');
  }
  if (value.method === 'collection.resolve-targets') {
    const expected = {
      date: ['selectorKind', 'date'],
      'latest-complete': ['selectorKind', 'date'],
      'date-range': ['selectorKind', 'start', 'end'],
      'exact-target': ['selectorKind', 'key'],
    }[value.input.selectorKind];
    if (!expected || !exactKeys(value.input, expected)
        || expected.filter(key => key !== 'selectorKind').some(key => typeof value.input[key] !== 'string')) fail('invalid_request');
  }
  if (Date.now() >= Date.parse(value.deadline)) fail('deadline_exceeded');
  return value;
}

function periodsFor(date) {
  const current = periodContaining(date);
  return [
    { ...previousPeriod(current), relation: 'previous' },
    { ...current, relation: 'current' },
    { ...nextPeriod(current), relation: 'next' },
  ].map(({ start, end, key, relation }) => ({ start, end, key, relation }));
}

function resolvedTargets(input) {
  let periods;
  if (input.selectorKind === 'date') periods = [periodContaining(input.date)];
  else if (input.selectorKind === 'latest-complete') periods = [previousPeriod(periodContaining(input.date))];
  else if (input.selectorKind === 'exact-target') periods = [periodFromEnd(input.key)];
  else {
    if (input.start > input.end) fail('invalid_period');
    periods = [];
    let period = periodContaining(input.start);
    while (period.start <= input.end) {
      periods.push(period);
      if (periods.length > 512) fail('invalid_period');
      period = nextPeriod(period);
    }
  }
  return {
    targetType: 'pay-period',
    targets: periods.map(period => ({
      key: period.end, start: period.start, end: period.end, values: { periodEnd: period.end },
    })),
  };
}

function candidateBase(request, kind, target, metadata, rows) {
  return { kind, target, runId: request.runId, attempt: request.attempt, collectedAt: new Date().toISOString(), metadata, rows };
}

function publish(store, request, candidate, stagingRoot) {
  const stage = stageCandidate(stagingRoot, candidate);
  let result;
  try {
    result = store.publish(stage);
  } finally {
    cleanupStage(stage, stagingRoot);
  }
  return {
    ok: true,
    status: result.disposition === 'no_change' ? 'no_change' : 'published',
    data: {
      method: request.method, target: candidate.target, publicationId: result.publicationId,
      disposition: result.disposition, rowCount: result.rowCount, contentSha256: result.contentSha256,
    },
  };
}

async function execute(request, {
  database,
  stagingRoot,
  rosterCollector = collectRoster,
  timecardCollector = collectTimecards,
  browserRunner,
  authentication,
  businessClock = () => new Date(),
} = {}) {
  validateRequest(request);
  if (typeof rosterCollector !== 'function' || typeof timecardCollector !== 'function'
      || typeof browserRunner !== 'function' || typeof businessClock !== 'function') fail('invalid_request');
  const startedAt = businessClock();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.valueOf())) fail('invalid_request');
  const today = dateInTimezone(request.source.config.timezone, startedAt);
  const current = periodContaining(today);
  if (request.method === 'collection.resolve-targets') {
    return { ok: true, status: 'succeeded', data: resolvedTargets(request.input) };
  }
  const store = new PaycomStore(database);
  const publishCandidate = candidate => publish(store, request, candidate, stagingRoot);
  try {
    if (request.method === 'collector.health') {
      let authenticationState = 'unavailable';
      try {
        authenticationState = await authentication();
      } catch {}
      const payPeriods = store.audit('pay_periods');
      const roster = store.audit('roster');
      const activeTimecards = store.active('timecards');
      const timecards = activeTimecards ? store.auditTimecards(activeTimecards.target) : store.audit('timecards');
      const resourceLinks = store.auditResourceLinks(TIMECARD_SUMMARY);
      return { ok: true, status: 'succeeded', data: { method: request.method, database: fs.existsSync(database) ? 'ready' : 'missing', authentication: authenticationState, payPeriods, roster, timecards, resourceLinks } };
    }
    if (request.method === 'pay-periods.discover') {
      const rows = periodsFor(today);
      return publishCandidate(candidateBase(request, 'pay_periods', today, {
        timezone: request.source.config.timezone, basis: 'biweekly_anchor', anchorStart: ANCHOR_START,
      }, rows));
    }
    if (request.method === 'sync.current-workforce') {
      const replay = store.shadowReceiptForRun(request.source.id, current.end, request.runId);
      if (replay) {
        const outcome = replay.syncOutcome || {
          mode: 'shadow', disposition: 'no_change', publicationStatus: 'shadow',
          wouldPublish: false, mirror: null, publications: null,
        };
        const { syncOutcome: ignored, ...observation } = replay;
        return {
          ok: true,
          status: outcome.disposition,
          data: {
            method: request.method,
            target: current.end,
            businessDate: outcome.businessDate || outcome.persistence?.date || today,
            businessTimezone: outcome.businessTimezone || request.source.config.timezone,
            mode: outcome.mode,
            publicationStatus: outcome.publicationStatus,
            wouldPublish: outcome.wouldPublish,
            sourceCompleteness: replay.sourceCompleteness || 'observation_only',
            ...observation,
            ...(outcome.mirror ? { mirror: outcome.mirror } : {}),
            ...(outcome.delta ? { delta: outcome.delta } : {}),
            ...(outcome.persistence ? { persistence: outcome.persistence } : {}),
            ...(outcome.publications ? { publications: outcome.publications } : {}),
            replayed: true,
          },
        };
      }
      const publishMode = request.input.publishMode || 'shadow';
      let publicationContext = null;
      if (['additions_edits_preview', 'additions_edits'].includes(publishMode)) {
        const rosterPublication = store.active('roster', current.end);
        const timecardPublication = store.active('timecards', current.end);
        if (rosterPublication && timecardPublication) {
          const rosterAudit = store.audit('roster', current.end);
          const timecardAudit = store.auditTimecards(current.end);
          if (!rosterAudit.verified || !timecardAudit.verified) fail('integrity_failed');
          const priorRoster = store.activeRoster(current.end);
          const priorTimecards = store.activeTimecards(current.end);
          const priorLinks = store.activeResourceLinks(TIMECARD_SUMMARY, current.end);
          if (priorLinks && !store.auditResourceLinks(TIMECARD_SUMMARY, current.end).verified) fail('integrity_failed');
          publicationContext = {
            priorRoster,
            priorTimecards,
            resourceLinksLoaded: Boolean(priorLinks),
            base: {
              rosterPublicationId: rosterPublication.id,
              rosterContentSha256: rosterPublication.content_sha256,
              timecardPublicationId: timecardPublication.id,
              timecardContentSha256: timecardPublication.content_sha256,
              resourceLinkPublicationId: priorLinks?.publication.id || null,
              resourceLinkContentSha256: priorLinks?.publication.content_sha256 || null,
            },
          };
        } else if (!rosterPublication && !timecardPublication
            && !store.activeResourceLinks(TIMECARD_SUMMARY, current.end)) {
          publicationContext = {
            priorRoster: { employees: [] }, priorTimecards: { rows: [] },
            resourceLinksLoaded: false, base: null,
          };
        } else fail('integrity_failed');
      }
      const browserStarted = performance.now();
      const shadow = await browserRunner(request, async ({ endpoint }) => {
        const captured = await rosterCollector(endpoint, current, { unfiltered: true });
        if (!captured?.completeness?.observable) {
          fail(captured?.completeness?.authorityCode || 'roster_source_not_authoritative');
        }
        const requestedPeriodEnforced = captured.uiPeriod !== undefined;
        if (requestedPeriodEnforced && (!captured.uiPeriod
            || Object.keys(captured.uiPeriod).sort().join(',') !== 'end,start')) fail('roster_period_mismatch');
        const parsed = parseRosterSource(captured.bytes);
        if (parsed.employeeCount !== captured.completeness.returnedCount) fail('roster_membership_mismatch');
        const bootstrap = publicationContext?.base === null;
        if (bootstrap && !captured.completeness.authoritative) fail('roster_source_not_authoritative');
        const observedDate = businessClock();
        if (!(observedDate instanceof Date) || Number.isNaN(observedDate.valueOf())) fail('invalid_request');
        const observedAt = observedDate.toISOString();
        const selection = store.planWorkforceShadow({
          sourceId: request.source.id,
          target: current.end,
          observedAt,
          employees: parsed.employees,
          reconcileBatchSize: request.input.reconcileBatchSize,
          fullReconcileMinutes: request.input.fullReconcileMinutes,
          fullCollection: bootstrap,
        });
        const collection = await timecardCollector(
          endpoint, selection.selectedEmployees, current, request.source.config.maxConcurrency,
        );
        const expected = selection.selectedEmployees.map(employee => employee.employeeCode).sort();
        const actual = collection.rows.map(row => row.employeeCode).sort();
        if (expected.length !== actual.length
            || expected.some((code, index) => code !== actual[index])) fail('membership_mismatch');
        return { captured, parsed, observedAt, selection, collection, requestedPeriodEnforced };
      });
      if (dateInTimezone(request.source.config.timezone, new Date(shadow.observedAt)) !== today) {
        fail('business_date_changed');
      }
      const observationInput = {
        sourceId: request.source.id,
        target: current.end,
        runId: request.runId,
        observedAt: shadow.observedAt,
        sourceSha256: shadow.captured.sourceSha256,
        employees: shadow.parsed.employees,
        sourceCompleteness: shadow.captured.completeness.authoritative ? 'authoritative' : 'observation_only',
        timecardRows: shadow.collection.rows,
        reconcileBatchSize: request.input.reconcileBatchSize,
        fullReconcileMinutes: request.input.fullReconcileMinutes,
        fullCollection: publicationContext?.base === null,
      };
      let disposition = 'no_change';
      let publicationStatus = publishMode === 'shadow' ? 'shadow' : 'baseline_required';
      let wouldPublish = false;
      let observation;
      let mirror = null;
      let delta = null;
      let persistence = null;
      let publications = null;
      if (['additions_edits_preview', 'additions_edits'].includes(publishMode) && publicationContext) {
        const mirrorPlan = planWorkforceMirror({
          period: current,
          priorRosterRows: publicationContext.priorRoster.employees,
          priorTimecardRows: publicationContext.priorTimecards.rows,
          sourceEmployees: shadow.parsed.employees,
          collectedTimecardRows: shadow.collection.rows,
        });
        if (!publicationContext.resourceLinksLoaded) mirrorPlan.hasChanges = true;
        const operationInput = {
          runId: request.runId,
          attempt: request.attempt,
          collectedAt: shadow.observedAt,
          coverageDate: today,
          businessTimezone: request.source.config.timezone,
          period: current,
          sourceSha256: shadow.captured.sourceSha256,
          sourceFormat: shadow.parsed.sourceFormat,
          sourceEmployees: shadow.parsed.employees,
          mirrorPlan,
          observation: observationInput,
          stagingRoot,
          base: publicationContext.base,
        };
        const published = publishMode === 'additions_edits_preview'
          ? store.previewWorkforceSync(operationInput)
          : store.publishWorkforceSync(operationInput);
        disposition = published.disposition;
        publicationStatus = publishMode === 'additions_edits_preview' ? 'preview' : 'ready';
        wouldPublish = published.wouldPublish;
        observation = published.observation;
        mirror = published.counts;
        delta = published.delta || null;
        persistence = published.persistence || null;
        if (published.rosterPublicationId) {
          publications = {
            rosterPublicationId: published.rosterPublicationId,
            timecardPublicationId: published.timecardPublicationId,
            resourceLinkPublicationId: published.resourceLinkPublicationId,
          };
        }
      } else {
        const syncOutcome = publishMode === 'shadow'
          ? {
            mode: 'shadow', disposition: 'no_change', publicationStatus: 'shadow',
            wouldPublish: false, mirror: null, publications: null,
            businessDate: today, businessTimezone: request.source.config.timezone,
          }
          : {
            mode: publishMode, disposition: 'no_change', publicationStatus: 'baseline_required',
            wouldPublish: false, mirror: null, publications: null,
            businessDate: today, businessTimezone: request.source.config.timezone,
          };
        observation = store.observeWorkforceShadow({ ...observationInput, syncOutcome });
      }
      const { syncOutcome: ignored, ...observationData } = observation;
      return {
        ok: true,
        status: disposition,
        data: {
          method: request.method,
          target: current.end,
          businessDate: today,
          businessTimezone: request.source.config.timezone,
          mode: publishMode,
          publicationStatus,
          wouldPublish,
          sourceCompleteness: observation.sourceCompleteness,
          disposition,
          ...observationData,
          ...(mirror ? { mirror } : {}),
          ...(delta ? { delta } : {}),
          ...(persistence ? { persistence } : {}),
          ...(publications ? { publications } : {}),
          performance: {
            ...shadow.collection.performance,
            requestedPeriodEnforced: shadow.requestedPeriodEnforced,
            browserMs: Math.round(performance.now() - browserStarted),
          },
        },
      };
    }
    if (['roster.snapshot', 'roster.period'].includes(request.method)) {
      const rosterPeriod = request.method === 'roster.period' ? periodFromEnd(request.input.periodEnd) : current;
      const captured = await browserRunner(request, ({ endpoint }) => rosterCollector(endpoint, rosterPeriod));
      const parsed = parseRosterSource(captured.bytes);
      const metadata = {
        periodKey: rosterPeriod.key, sourceSha256: captured.sourceSha256,
        employeeCount: parsed.employeeCount, activeEmployeeCount: parsed.activeEmployeeCount,
        activeDriverCount: parsed.activeDriverCount, sourceFormat: parsed.sourceFormat,
      };
      return publishCandidate(candidateBase(request, 'roster', rosterPeriod.end, metadata, parsed.employees));
    }
    if (request.method.startsWith('resource-links.')) {
      const linkPeriod = 'periodEnd' in request.input ? periodFromEnd(request.input.periodEnd) : current;
      if (request.method === 'resource-links.audit') {
        const audit = store.auditResourceLinks(request.input.resourceType, linkPeriod.end);
        if (!audit.verified) return { ok: false, status: 'failed', data: { method: request.method, audit }, error: { code: audit.code } };
        return { ok: true, status: 'succeeded', data: { method: request.method, audit } };
      }
      const roster = store.activeRoster(linkPeriod.end);
      const activeEmployees = roster.employees.filter(employee => employee.isActive);
      const rows = linkRows(request.input.resourceType, activeEmployees, linkPeriod);
      const receipt = publishCandidate({
        ...candidateBase(request, 'resource_links', linkPeriod.end, {
          resourceType: request.input.resourceType,
          periodStart: linkPeriod.start,
          periodEnd: linkPeriod.end,
          rosterPublicationId: roster.publication.id,
          rosterContentSha256: roster.publication.content_sha256,
          routeVersion: ROUTE_VERSION,
        }, rows),
        periodKey: linkPeriod.key,
      });
      const audit = store.auditResourceLinks(request.input.resourceType, linkPeriod.end);
      if (!audit.verified || audit.rowCount !== activeEmployees.length) fail('integrity_failed');
      receipt.data.audit = { verified: true, activeEmployees: activeEmployees.length, links: audit.rowCount };
      return receipt;
    }
    if (request.method === 'timecards.audit') {
      const auditPeriod = periodFromEnd(request.input.periodEnd);
      const audit = store.auditTimecards(auditPeriod.end);
      if (!audit.verified) return { ok: false, status: 'failed', data: { method: request.method, audit }, error: { code: audit.code } };
      return { ok: true, status: 'succeeded', data: { method: request.method, audit } };
    }
    if (request.method === 'reconcile.current-period') {
      const audit = store.auditTimecards(current.end);
      if (!audit.verified) return { ok: false, status: 'failed', data: { method: request.method, audit }, error: { code: audit.code } };
      return { ok: true, status: 'succeeded', data: { method: request.method, audit } };
    }
    const period = ['timecards.period', 'timecards.from-published-roster'].includes(request.method)
      ? periodFromEnd(request.input.periodEnd) : current;
    if (request.method === 'timecards.period') {
      const browserStarted = performance.now();
      const historical = await browserRunner(request, async ({ endpoint }) => {
        const captured = await rosterCollector(endpoint, period);
        const parsed = parseRosterSource(captured.bytes);
        const employees = parsed.employees.filter(employee => employee.isActive)
          .map(employee => ({ employeeCode: employee.employeeCode, employeeName: employee.employeeName }));
        if (!employees.length) fail('roster_invalid');
        const collection = await timecardCollector(endpoint, employees, period, request.source.config.maxConcurrency);
        const rows = collection.rows;
        const expected = [...employees.map(employee => employee.employeeCode)].sort();
        const actual = [...rows.map(row => row.employeeCode)].sort();
        if (expected.length !== actual.length || expected.some((code, index) => code !== actual[index])) fail('membership_mismatch');
        return { captured, parsed, rows, performance: collection.performance };
      });
      const receipt = publishCandidate({
        ...candidateBase(request, 'timecards', period.end, {
          periodStart: period.start, periodEnd: period.end,
          rosterSourceSha256: historical.captured.sourceSha256,
          rosterEmployeeCount: historical.parsed.employeeCount,
          activeEmployeeCount: historical.rows.length,
          mode: 'historical_period_membership',
        }, historical.rows),
        periodKey: period.key,
      });
      receipt.data.performance = { ...historical.performance, browserMs: Math.round(performance.now() - browserStarted) };
      return receipt;
    }
    const roster = store.activeRoster(period.end);
    const rosterAudit = store.audit('roster', period.end);
    if (!rosterAudit.verified) fail('integrity_failed');
    if (roster.publication.target !== period.end) fail('roster_period_mismatch');
    const activeEmployees = roster.employees.filter(employee => employee.isActive)
      .map(employee => ({ employeeCode: employee.employeeCode, employeeName: employee.employeeName }));
    if (!activeEmployees.length) fail('roster_invalid');
    let rows;
    let collectionPerformance = null;
    let mode = request.method === 'timecards.from-published-roster' ? 'published_roster' : 'full';
    if (request.method === 'timecards.incremental') {
      mode = 'incremental';
      const prior = store.activeTimecards(period.end);
      const activeByCode = new Map(activeEmployees.map(employee => [employee.employeeCode, employee]));
      const retained = (prior?.rows || []).filter(row => activeByCode.has(row.employeeCode))
        .map(row => ({ ...row, employeeName: activeByCode.get(row.employeeCode).employeeName }));
      const present = new Set(retained.map(row => row.employeeCode));
      const missing = activeEmployees.filter(employee => !present.has(employee.employeeCode));
      if (!missing.length && retained.length === activeEmployees.length) {
        const audit = store.auditTimecards(period.end);
        if (!audit.verified) fail(audit.code);
        return { ok: true, status: 'no_change', data: { method: request.method, target: period.end, publicationId: prior.publication.id, disposition: 'complete', rowCount: retained.length, audit } };
      }
      let collected = [];
      if (missing.length) {
        const browserStarted = performance.now();
        const collection = await browserRunner(request, ({ endpoint }) => timecardCollector(endpoint, missing, period, request.source.config.maxConcurrency));
        collected = collection.rows;
        collectionPerformance = { ...collection.performance, browserMs: Math.round(performance.now() - browserStarted) };
      }
      rows = [...retained, ...collected].sort((left, right) => left.employeeCode.localeCompare(right.employeeCode));
    } else {
      const browserStarted = performance.now();
      const collection = await browserRunner(request, ({ endpoint }) => timecardCollector(endpoint, activeEmployees, period, request.source.config.maxConcurrency));
      rows = collection.rows;
      collectionPerformance = { ...collection.performance, browserMs: Math.round(performance.now() - browserStarted) };
    }
    const expectedCodes = [...activeEmployees.map(employee => employee.employeeCode)].sort();
    const actualCodes = [...rows.map(row => row.employeeCode)].sort();
    if (expectedCodes.length !== actualCodes.length || expectedCodes.some((code, index) => code !== actualCodes[index])) fail('membership_mismatch');
    const candidate = {
      ...candidateBase(request, 'timecards', period.end, {
        periodStart: period.start, periodEnd: period.end, rosterPublicationId: roster.publication.id,
        rosterContentSha256: roster.publication.content_sha256, mode,
      }, rows),
      periodKey: period.key,
    };
    const receipt = publishCandidate(candidate);
    const audit = store.auditTimecards(period.end);
    if (!audit.verified) fail(audit.code);
    receipt.data.audit = audit;
    if (collectionPerformance) receipt.data.performance = collectionPerformance;
    return receipt;
  } finally {
    try { store.close(); }
    finally { cleanupRunStages(stagingRoot, request.runId); }
  }
}

function safeFailure(error) {
  const candidate = error?.code || error?.message;
  const code = SAFE_ERRORS.has(candidate) || /^timecard_[a-z0-9_]{1,55}$/.test(candidate || '') ? candidate : 'collection_failed';
  return { ok: false, status: 'failed', data: null, error: { code } };
}

module.exports = { METHODS, SAFE_ERRORS, validateRequest, dateInTimezone, periodsFor, resolvedTargets, execute, safeFailure };
