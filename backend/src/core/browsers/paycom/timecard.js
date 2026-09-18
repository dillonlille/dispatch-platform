// DOM extraction and strict layout validation adapted from the archived Paycom provider.
(config) => {
  const DAY = 86400000,
    ANCHOR_START = '2026-07-26',
    BASE = 'https://www.paycomonline.net/v4/cl/web.php/timecard/index';
  function isoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error('invalid_period');
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value)
      throw new Error('invalid_period');
    return date;
  }
  function iso(date) {
    return date.toISOString().slice(0, 10);
  }
  function fromBounds(start, end) {
    const a = isoDate(start),
      b = isoDate(end);
    if (a.getUTCDay() !== 0 || b.getUTCDay() !== 6 || b - a !== 13 * DAY)
      throw new Error('invalid_period');
    const dates = Array.from({ length: 14 }, (_, i) => iso(new Date(a.valueOf() + i * DAY)));
    return Object.freeze({ start, end, key: `${start}_${end}`, dates: Object.freeze(dates) });
  }
  function periodFromEnd(end) {
    const b = isoDate(end);
    if (b.getUTCDay() !== 6) throw new Error('invalid_period');
    return fromBounds(iso(new Date(b.valueOf() - 13 * DAY)), end);
  }
  function periodContaining(value) {
    const target = isoDate(value),
      anchor = isoDate(ANCHOR_START),
      index = Math.floor((target - anchor) / (14 * DAY)),
      start = new Date(anchor.valueOf() + index * 14 * DAY);
    return fromBounds(iso(start), iso(new Date(start.valueOf() + 13 * DAY)));
  }
  function parsePeriodKey(key) {
    if (
      typeof key !== 'string' ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(key)
    )
      throw new Error('invalid_period');
    const [start, end] = key.split('_');
    return fromBounds(start, end);
  }
  function shift(period, days) {
    const p = parsePeriodKey(period.key);
    return fromBounds(
      iso(new Date(isoDate(p.start).valueOf() + days * DAY)),
      iso(new Date(isoDate(p.end).valueOf() + days * DAY)),
    );
  }
  function nextPeriod(period) {
    return shift(period, 14);
  }
  function previousPeriod(period) {
    return shift(period, -14);
  }
  function validateCode(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{4}$/.test(code))
      throw new Error('invalid_employee_code');
    return code;
  }
  function canonicalTimecardUrl(code, period) {
    validateCode(code);
    const p = parsePeriodKey(period.key),
      url = new URL(BASE);
    url.searchParams.set('firstrefno', code);
    url.searchParams.set('perioddates', p.key);
    url.searchParams.set('formtype', 'SUMMARY');
    return url.href;
  }
  function buildTimecardUrl(code, period, variant) {
    if (variant !== 1 && variant !== 2) throw new Error('navigation_policy_violation');
    const url = new URL(canonicalTimecardUrl(code, period));
    url.searchParams.set('dispatch_timecards', String(variant));
    return url.href;
  }
  function sameTimecardIdentity(url, expected) {
    return (
      url.protocol === expected.protocol &&
      url.hostname === expected.hostname &&
      url.port === '' &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === expected.pathname &&
      url.hash === '' &&
      url.searchParams.getAll('firstrefno').length === 1 &&
      url.searchParams.get('firstrefno') === expected.searchParams.get('firstrefno') &&
      url.searchParams.getAll('perioddates').length === 1 &&
      url.searchParams.get('perioddates') === expected.searchParams.get('perioddates') &&
      url.searchParams.getAll('formtype').length === 1 &&
      url.searchParams.get('formtype') === 'SUMMARY'
    );
  }
  function isCapturedTimecardUrl(value, { employeeCode, period }) {
    try {
      const url = new URL(value),
        expected = new URL(canonicalTimecardUrl(employeeCode, period)),
        keys = [...url.searchParams.keys()].sort();
      return (
        sameTimecardIdentity(url, expected) &&
        keys.join(',') === 'dispatch_timecards,firstrefno,formtype,perioddates' &&
        url.searchParams.getAll('dispatch_timecards').length === 1 &&
        ['1', '2'].includes(url.searchParams.get('dispatch_timecards'))
      );
    } catch {
      return false;
    }
  }
  function isCanonicalTimecardUrl(value, { employeeCode, period }) {
    try {
      const url = new URL(value),
        expected = new URL(canonicalTimecardUrl(employeeCode, period)),
        keys = [...url.searchParams.keys()].sort();
      return (
        sameTimecardIdentity(url, expected) && keys.join(',') === 'firstrefno,formtype,perioddates'
      );
    } catch {
      return false;
    }
  }

  const HEADERS = Object.freeze([
    'date',
    'paycode',
    'i1',
    'allocation1',
    'o1',
    'i2',
    'allocation2',
    'o2',
    'hours',
    'total_hours',
    'amount',
    'exception-points',
    'waiver',
    'comment',
    'missing-punch',
    'delete',
  ]);
  const HEADERS_NO_WAIVER = Object.freeze(HEADERS.filter((value) => value !== 'waiver'));
  const SLOTS = Object.freeze(['i1', 'o1', 'i2', 'o2']);
  const KINDS = Object.freeze(['IN DAY', 'OUT LUNCH', 'IN LUNCH', 'OUT DAY']);
  const LABELS = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
  const TIME = /^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$/;
  const CHANGE_OPERATIONS = Object.freeze(['add', 'edit', 'delete', 'type_change']);
  const CHANGE_DETAIL_STATES = Object.freeze(['not_applicable', 'unavailable', 'complete']);
  const RECORD_KEYS = Object.freeze([
    'additionalRows',
    'approvals',
    'attestations',
    'days',
    'employeeCode',
    'headers',
    'mealWaivers',
    'pageTitle',
    'periodEnd',
    'periodKey',
    'periodStart',
    'periodTotalHours',
    'sourceFormat',
    'sourceUrl',
    'version',
    'weeklyTotals',
  ]);
  const DAY_KEYS = Object.freeze([
    'allocation1',
    'allocation2',
    'comments',
    'date',
    'dollars',
    'exceptionText',
    'hours',
    'label',
    'missingPunch',
    'payCode',
    'punches',
    'totalHours',
    'unresolvedSlots',
    'waiverChecked',
  ]);
  const ADDITIONAL_ROW_KEYS = Object.freeze([
    'allocation1',
    'allocation2',
    'comments',
    'date',
    'dollars',
    'exceptionText',
    'hours',
    'payCode',
    'punchOrdinals',
    'rowClass',
    'rowIndex',
    'totalHours',
    'unresolvedSlots',
    'waiverChecked',
  ]);
  const PUNCH_KEYS = Object.freeze([
    'actualTime',
    'approved',
    'changeDetailState',
    'changeNote',
    'changeOperation',
    'changeRequestStatus',
    'clockCode',
    'clockName',
    'comment',
    'currentKind',
    'currentTime',
    'displayTime',
    'kind',
    'ordinal',
    'provenanceAvailable',
    'requestedKind',
    'requestedTime',
    'roundedTime',
    'rowIndex',
    'slot',
  ]);

  // These are the only validation diagnostics that may cross the collector/CLI boundary.
  const TIME_CARD_VALIDATION_CODES = Object.freeze([
    'timecard_identity_invalid',
    'timecard_header_invalid',
    'timecard_day_count_invalid',
    'timecard_date_sequence_invalid',
    'timecard_day_label_invalid',
    'timecard_pay_code_invalid',
    'timecard_allocation_invalid',
    'timecard_exception_invalid',
    'timecard_day_number_invalid',
    'timecard_day_comments_invalid',
    'timecard_missing_punch_invalid',
    'timecard_punch_invalid',
    'timecard_provenance_invalid',
    'timecard_pcr_marker_invalid',
    'pending_change_detail_unavailable',
    'timecard_additional_row_invalid',
    'timecard_weekly_total_invalid',
    'timecard_period_total_invalid',
    'timecard_approval_invalid',
    'timecard_attestation_invalid',
    'timecard_waiver_invalid',
  ]);
  const TIME_CARD_VALIDATION_CODE_SET = new Set(TIME_CARD_VALIDATION_CODES);

  function invalid(code) {
    const safeCode = TIME_CARD_VALIDATION_CODE_SET.has(code) ? code : 'timecard_identity_invalid';
    const error = new Error(safeCode);
    error.code = safeCode;
    throw error;
  }

  function bounded(value, max) {
    return (
      typeof value === 'string' &&
      value.length <= max &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    );
  }

  function numberOrNull(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  }

  function exactKeys(value, keys) {
    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
  }

  function validateGenericRows(value, code) {
    if (!Array.isArray(value) || value.length > 500) invalid(code);
    for (const row of value) {
      if (!Array.isArray(row) || row.length > 20 || row.some((cell) => !bounded(cell, 1000)))
        invalid(code);
    }
  }

  function validatePunch(punch, index, seen) {
    const key = punch ? `${punch.rowIndex}:${punch.slot}` : '';
    if (
      !exactKeys(punch, PUNCH_KEYS) ||
      punch.ordinal !== index + 1 ||
      !Number.isInteger(punch.rowIndex) ||
      punch.rowIndex < 0 ||
      punch.rowIndex > 16 ||
      !SLOTS.includes(punch.slot) ||
      seen.has(key) ||
      !TIME.test(punch.displayTime)
    ) {
      invalid('timecard_punch_invalid');
    }
    if (
      !bounded(punch.clockName, 200) ||
      !bounded(punch.clockCode, 50) ||
      !bounded(punch.comment, 2000) ||
      typeof punch.provenanceAvailable !== 'boolean' ||
      ![null, 'approved', 'pending', 'rejected'].includes(punch.changeRequestStatus) ||
      typeof punch.approved !== 'boolean' ||
      punch.approved !== (punch.changeRequestStatus === 'approved')
    ) {
      invalid('timecard_provenance_invalid');
    }
    if (punch.provenanceAvailable) {
      if (
        !KINDS.includes(punch.kind) ||
        !TIME.test(punch.actualTime) ||
        !TIME.test(punch.roundedTime)
      )
        invalid('timecard_provenance_invalid');
    } else if (
      punch.kind !== '' ||
      punch.actualTime !== '' ||
      punch.roundedTime !== '' ||
      punch.clockName !== '' ||
      punch.clockCode !== '' ||
      punch.comment !== ''
    ) {
      invalid('timecard_provenance_invalid');
    }
    const nullableKind = (value) => value === null || KINDS.includes(value);
    const nullableTime = (value) => value === null || TIME.test(value);
    if (
      !CHANGE_DETAIL_STATES.includes(punch.changeDetailState) ||
      !nullableKind(punch.currentKind) ||
      !nullableKind(punch.requestedKind) ||
      !nullableTime(punch.currentTime) ||
      !nullableTime(punch.requestedTime) ||
      (punch.changeNote !== null && !bounded(punch.changeNote, 2000)) ||
      (punch.changeOperation !== null && !CHANGE_OPERATIONS.includes(punch.changeOperation))
    )
      invalid('timecard_provenance_invalid');
    const emptyDirection =
      punch.changeOperation === null &&
      punch.currentKind === null &&
      punch.currentTime === null &&
      punch.requestedKind === null &&
      punch.requestedTime === null &&
      punch.changeNote === null;
    if (punch.changeRequestStatus === null) {
      if (punch.changeDetailState !== 'not_applicable' || !emptyDirection)
        invalid('timecard_provenance_invalid');
    } else if (punch.changeDetailState === 'unavailable') {
      if (!emptyDirection) invalid('timecard_provenance_invalid');
    } else if (punch.changeDetailState !== 'complete') {
      invalid('timecard_provenance_invalid');
    } else {
      const currentPresent = punch.currentKind !== null && punch.currentTime !== null;
      const requestedPresent = punch.requestedKind !== null && punch.requestedTime !== null;
      if (punch.changeOperation === 'add') {
        if (punch.currentKind !== null || punch.currentTime !== null || !requestedPresent)
          invalid('timecard_provenance_invalid');
      } else if (punch.changeOperation === 'delete') {
        if (!currentPresent || punch.requestedKind !== null || punch.requestedTime !== null)
          invalid('timecard_provenance_invalid');
      } else if (punch.changeOperation === 'edit') {
        if (!currentPresent || !requestedPresent || punch.currentKind !== punch.requestedKind)
          invalid('timecard_provenance_invalid');
      } else if (punch.changeOperation === 'type_change') {
        if (!currentPresent || !requestedPresent || punch.currentKind === punch.requestedKind)
          invalid('timecard_provenance_invalid');
      } else invalid('timecard_provenance_invalid');
    }
    seen.add(key);
  }

  function validateTimecardRecord(value, { employeeCode, period, sourceUrl }) {
    validateCode(employeeCode);
    const expected = parsePeriodKey(period.key);
    const headerValid =
      Array.isArray(value?.headers) &&
      [HEADERS, HEADERS_NO_WAIVER].some(
        (schema) =>
          value.headers.length === schema.length &&
          value.headers.every((item, index) => item === schema[index]),
      );

    if (
      !exactKeys(value, RECORD_KEYS) ||
      value.version !== 2 ||
      value.sourceFormat !== 'paycom-timecard-dom.v2' ||
      value.employeeCode !== employeeCode ||
      value.periodStart !== expected.start ||
      value.periodEnd !== expected.end ||
      value.periodKey !== expected.key ||
      value.sourceUrl !== sourceUrl ||
      value.pageTitle !== 'Timecard Editor'
    ) {
      invalid('timecard_identity_invalid');
    }
    if (!headerValid) invalid('timecard_header_invalid');
    if (!Array.isArray(value.days) || value.days.length !== 14)
      invalid('timecard_day_count_invalid');
    if (!Array.isArray(value.additionalRows) || value.additionalRows.length > 200)
      invalid('timecard_additional_row_invalid');

    const hasWaiverColumn = value.headers.length === HEADERS.length;
    for (let index = 0; index < 14; index++) {
      const day = value.days[index];
      if (!exactKeys(day, DAY_KEYS) || day.date !== expected.dates[index])
        invalid('timecard_date_sequence_invalid');
      if (day.label !== LABELS[index % 7]) invalid('timecard_day_label_invalid');
      if (!bounded(day.payCode, 100)) invalid('timecard_pay_code_invalid');
      if (!bounded(day.allocation1, 300) || !bounded(day.allocation2, 300))
        invalid('timecard_allocation_invalid');
      if (!bounded(day.exceptionText, 2000)) invalid('timecard_exception_invalid');
      if (!numberOrNull(day.hours) || !numberOrNull(day.totalHours) || !numberOrNull(day.dollars))
        invalid('timecard_day_number_invalid');
      if (
        !Array.isArray(day.comments) ||
        day.comments.length > 20 ||
        day.comments.some((item) => !bounded(item, 2000))
      )
        invalid('timecard_day_comments_invalid');
      if (
        typeof day.missingPunch !== 'boolean' ||
        !Array.isArray(day.unresolvedSlots) ||
        day.unresolvedSlots.length > 32 ||
        day.unresolvedSlots.some(
          (item) => !/^(?:[1-9]|1[0-6]):(?:i1|o1|i2|o2)$|^(?:i1|o1|i2|o2)$/.test(item),
        ) ||
        new Set(day.unresolvedSlots).size !== day.unresolvedSlots.length ||
        day.missingPunch !== day.unresolvedSlots.length > 0
      )
        invalid('timecard_missing_punch_invalid');
      if (day.waiverChecked !== null && typeof day.waiverChecked !== 'boolean')
        invalid('timecard_waiver_invalid');
      if (!hasWaiverColumn && day.waiverChecked !== null) invalid('timecard_waiver_invalid');
      if (!Array.isArray(day.punches) || day.punches.length > 32) invalid('timecard_punch_invalid');
      const seen = new Set();
      day.punches.forEach((punch, punchIndex) => validatePunch(punch, punchIndex, seen));
    }

    const rowIds = new Set();
    for (const row of value.additionalRows) {
      if (
        !exactKeys(row, ADDITIONAL_ROW_KEYS) ||
        !expected.dates.includes(row.date) ||
        !Number.isInteger(row.rowIndex) ||
        row.rowIndex < 1 ||
        row.rowIndex > 16 ||
        rowIds.has(`${row.date}:${row.rowIndex}`) ||
        !bounded(row.rowClass, 300) ||
        !bounded(row.payCode, 2000) ||
        !bounded(row.allocation1, 300) ||
        !bounded(row.allocation2, 300) ||
        !numberOrNull(row.hours) ||
        !numberOrNull(row.totalHours) ||
        !numberOrNull(row.dollars) ||
        !bounded(row.exceptionText, 2000) ||
        !Array.isArray(row.comments) ||
        row.comments.length > 20 ||
        row.comments.some((item) => !bounded(item, 2000)) ||
        !Array.isArray(row.unresolvedSlots) ||
        row.unresolvedSlots.length > 32 ||
        row.unresolvedSlots.some((item) => !SLOTS.includes(item)) ||
        new Set(row.unresolvedSlots).size !== row.unresolvedSlots.length ||
        !Array.isArray(row.punchOrdinals) ||
        row.punchOrdinals.length > 32 ||
        row.punchOrdinals.some((item) => !Number.isInteger(item) || item < 1 || item > 32) ||
        new Set(row.punchOrdinals).size !== row.punchOrdinals.length
      ) {
        invalid('timecard_additional_row_invalid');
      }
      if (row.waiverChecked !== null && typeof row.waiverChecked !== 'boolean')
        invalid('timecard_waiver_invalid');
      if (!hasWaiverColumn && row.waiverChecked !== null) invalid('timecard_waiver_invalid');
      rowIds.add(`${row.date}:${row.rowIndex}`);
      const day = value.days[expected.dates.indexOf(row.date)];
      for (const ordinal of row.punchOrdinals) {
        const punch = day.punches[ordinal - 1];
        if (!punch || punch.rowIndex !== row.rowIndex) invalid('timecard_additional_row_invalid');
      }
      for (const slot of row.unresolvedSlots) {
        if (!day.unresolvedSlots.includes(`${row.rowIndex}:${slot}`))
          invalid('timecard_additional_row_invalid');
      }
    }

    if (
      !Array.isArray(value.weeklyTotals) ||
      value.weeklyTotals.length !== 2 ||
      value.weeklyTotals.some(
        (item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0,
      )
    )
      invalid('timecard_weekly_total_invalid');
    if (
      typeof value.periodTotalHours !== 'number' ||
      !Number.isFinite(value.periodTotalHours) ||
      value.periodTotalHours < 0
    )
      invalid('timecard_period_total_invalid');
    if (
      Math.abs(value.periodTotalHours - value.weeklyTotals.reduce((sum, item) => sum + item, 0)) >
      0.011
    )
      invalid('timecard_period_total_invalid');

    validateGenericRows(value.approvals, 'timecard_approval_invalid');
    validateGenericRows(value.attestations, 'timecard_attestation_invalid');
    validateGenericRows(value.mealWaivers, 'timecard_waiver_invalid');
    return value;
  }

  function renderedDayHeader(value) {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const match = text.match(/^([A-Z]{3})\s*\(([0-9]{2}\/[0-9]{2})\)$/);
    return match ? { label: match[1], dateText: match[2] } : null;
  }

  function bindRenderedDayDate(value, expectedDate) {
    const header = renderedDayHeader(value);
    return header &&
      typeof expectedDate === 'string' &&
      header.dateText === expectedDate.slice(5).replace('-', '/')
      ? expectedDate
      : '';
  }

  function resolveObservedEmployeeCode(values) {
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9]{4}$/.test(value))
    )
      return '';
    const codes = [...new Set(values.map((value) => value.toUpperCase()))];
    return codes.length === 1 ? codes[0] : '';
  }

  function normalizeRequestDetail(observed) {
    const empty = (state) => ({
      changeOperation: null,
      currentKind: null,
      currentTime: null,
      requestedKind: null,
      requestedTime: null,
      changeNote: null,
      changeDetailState: state,
    });
    const unavailable = () => empty('unavailable');
    const keys = [
      'operation',
      'currentKind',
      'currentTime',
      'requestedKind',
      'requestedTime',
      'note',
    ];
    if (
      !observed ||
      typeof observed !== 'object' ||
      Array.isArray(observed) ||
      keys.some((key) => !Array.isArray(observed[key]))
    )
      throw new Error('timecard_provenance_invalid');
    // No directly exposed direction is the safe permission-limited state. Once
    // any direction field is exposed, the whole observation must be singular
    // and complete; partial or malformed detail must not be collapsed into the
    // permission-limited state.
    if (keys.every((key) => observed[key].length === 0)) return unavailable();
    // Direction fields are required even when the directly observed value is an
    // empty string. An explicit empty value is absence evidence; a missing,
    // duplicate, or contradictory observation is not.
    if (keys.slice(0, 5).some((key) => observed[key].length !== 1) || observed.note.length > 1)
      throw new Error('timecard_provenance_invalid');
    const raw = Object.fromEntries(keys.slice(0, 5).map((key) => [key, observed[key][0]]));
    if (Object.values(raw).some((value) => typeof value !== 'string' || value.length > 200))
      throw new Error('timecard_provenance_invalid');
    const operationAliases = new Map([
      ['add', 'add'],
      ['edit', 'edit'],
      ['delete', 'delete'],
      ['type_change', 'type_change'],
      ['type change', 'type_change'],
    ]);
    const kindAliases = new Map([
      ['IN DAY', 'IN DAY'],
      ['OUT LUNCH', 'OUT LUNCH'],
      ['IN LUNCH', 'IN LUNCH'],
      ['OUT DAY', 'OUT DAY'],
      ['OUT BREAK', 'OUT LUNCH'],
      ['IN BREAK', 'IN LUNCH'],
    ]);
    const operation = operationAliases.get(raw.operation.toLowerCase());
    const kind = (value) => (value === '' ? null : kindAliases.get(value.toUpperCase()));
    const time = (value) =>
      value === ''
        ? null
        : /^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$/.test(value.toUpperCase())
          ? value.toUpperCase()
          : undefined;
    const currentKind = kind(raw.currentKind);
    const requestedKind = kind(raw.requestedKind);
    const currentTime = time(raw.currentTime);
    const requestedTime = time(raw.requestedTime);
    const note = observed.note.length === 0 ? null : observed.note[0];
    if (
      !operation ||
      currentKind === undefined ||
      requestedKind === undefined ||
      currentTime === undefined ||
      requestedTime === undefined ||
      (typeof note !== 'string' && note !== null) ||
      (note !== null && (note.length > 2000 || /[\u0000-\u001f\u007f]/.test(note)))
    )
      throw new Error('timecard_provenance_invalid');
    const complete =
      operation === 'add'
        ? currentKind === null &&
          currentTime === null &&
          requestedKind !== null &&
          requestedTime !== null
        : operation === 'delete'
          ? currentKind !== null &&
            currentTime !== null &&
            requestedKind === null &&
            requestedTime === null
          : operation === 'edit'
            ? currentKind !== null &&
              currentKind === requestedKind &&
              currentTime !== null &&
              requestedTime !== null
            : currentKind !== null &&
              requestedKind !== null &&
              currentKind !== requestedKind &&
              currentTime !== null &&
              requestedTime !== null;
    if (!complete) throw new Error('timecard_provenance_invalid');
    return {
      changeOperation: operation,
      currentKind,
      currentTime,
      requestedKind,
      requestedTime,
      changeNote: note,
      changeDetailState: 'complete',
    };
  }

  function runtimeExtract(config, normalizeRequestDetail, resolveObservedEmployeeCode) {
    const clean = (value) =>
      String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const decode = (value) => {
      let out = String(value ?? '');
      for (let index = 0; index < 2; index++) {
        const div = document.createElement('div');
        div.innerHTML = out.replace(/<br\s*\/?>/gi, '\n');
        out = div.textContent || '';
      }
      return out
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    };
    const numeric = (value) => {
      const text = clean(value);
      if (!text) return null;
      const number = Number(text.replace(/[$,]/g, ''));
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const visible = (element) => {
      if (!element) return '';
      const clone = element.cloneNode(true);
      clone.querySelectorAll('script,style').forEach((node) => node.remove());
      return clean(clone.textContent);
    };
    const controlValue = (element) => {
      if (!element) return '';
      const select = element.querySelector('select');
      if (select) return clean(select.value || select.selectedOptions?.[0]?.textContent);
      const input = element.querySelector('input,textarea');
      if (input) return clean(input.value);
      const triggers = Array.from(
        element.querySelectorAll('a.popoverTrigger.popoverTrigger--text'),
      ).filter((e) => e.offsetParent !== null);
      return triggers.length === 1 ? clean(triggers[0].textContent) : visible(element);
    };
    const renderedPunchTime = (element) => {
      if (!element) return '';
      const pattern = /^(0?[1-9]|1[0-2]):([0-5][0-9]) ([AP])M$/;
      const values = Array.from(element.children)
        .filter((child) => child.offsetParent !== null && child.getClientRects().length > 0)
        .map((child) => clean(child.textContent))
        .filter((value) => pattern.test(value));
      if (values.length !== 1) return controlValue(element);
      const match = values[0].match(pattern);
      return `${match[1].padStart(2, '0')}:${match[2]} ${match[3]}M`;
    };
    const dayHeader = (value) => {
      const match = clean(value).match(/^([A-Z]{3})\s*\(([0-9]{2}\/[0-9]{2})\)$/);
      return match ? { label: match[1], dateText: match[2] } : null;
    };
    const boundDate = (value, expectedDate) => {
      const header = dayHeader(value);
      return header && header.dateText === expectedDate.slice(5).replace('-', '/')
        ? expectedDate
        : '';
    };
    const table = document.querySelector('#tbltimesheet');
    if (!table) return null;
    const identityElements = Array.from(
      document.querySelectorAll(
        'input[name="firstrefno"],input#firstrefno,[data-firstrefno],[data-employee-code]',
      ),
    );
    const identityValues = identityElements
      .map((element) =>
        clean(
          element.value ||
            element.getAttribute('data-firstrefno') ||
            element.getAttribute('data-employee-code'),
        ),
      )
      .filter(Boolean);
    const observedEmployeeCode = resolveObservedEmployeeCode(identityValues);
    const headers = Array.from(table.querySelectorAll('thead [data-column]')).map((element) =>
      element.getAttribute('data-column'),
    );
    const column = (name) => headers.indexOf(name);
    const cell = (cells, name) => cells[column(name)];
    const allRows = Array.from(table.querySelectorAll(':scope > tbody > tr'));
    const isDay = (row) => Boolean(dayHeader(row.children[0]?.textContent));
    const isWeekly = (row) => /^Weekly Totals$/i.test(clean(row.children[0]?.textContent));
    const slots = [
      ['i1', column('i1')],
      ['o1', column('o1')],
      ['i2', column('i2')],
      ['o2', column('o2')],
    ];
    const parsePunch = (element, slot, rowIndex) => {
      const displayTime = renderedPunchTime(element);
      if (!displayTime || displayTime === '??') return null;
      const nodes = [element, ...Array.from(element.querySelectorAll('*'))];
      if (nodes.length > 128) throw new Error('timecard_pcr_marker_invalid');
      const markerTokens = [];
      for (const candidate of nodes) {
        for (const token of Array.from(candidate.classList || [])) {
          if (/^pcr/i.test(token)) {
            if (token.length > 100) throw new Error('timecard_pcr_marker_invalid');
            markerTokens.push(token);
          }
          if (markerTokens.length > 256) throw new Error('timecard_pcr_marker_invalid');
        }
      }
      const markerStates = {
        pcrApproved: 'approved',
        pcrPending: 'pending',
        pcrRejected: 'rejected',
      };
      if (
        markerTokens.some((token) => !Object.prototype.hasOwnProperty.call(markerStates, token)) ||
        new Set(markerTokens).size !== markerTokens.length ||
        markerTokens.length > 1
      )
        throw new Error('timecard_pcr_marker_invalid');
      const changeRequestStatus = markerTokens.length ? markerStates[markerTokens[0]] : null;
      const approved = changeRequestStatus === 'approved';
      const directChange = () => {
        if (changeRequestStatus === null)
          return {
            changeOperation: null,
            currentKind: null,
            currentTime: null,
            requestedKind: null,
            requestedTime: null,
            changeNote: null,
            changeDetailState: 'not_applicable',
          };
        const attributes = {
          operation: ['data-pcr-operation', 'data-change-operation'],
          currentKind: ['data-pcr-current-kind', 'data-pcr-current-type'],
          currentTime: ['data-pcr-current-time'],
          requestedKind: ['data-pcr-requested-kind', 'data-pcr-requested-type'],
          requestedTime: ['data-pcr-requested-time'],
          note: ['data-pcr-note', 'data-change-note'],
        };
        const labels = {
          operation: ['Operation', 'Request Operation'],
          currentKind: ['Current Kind', 'Current Type'],
          currentTime: ['Current Time'],
          requestedKind: ['Requested Kind', 'Requested Type'],
          requestedTime: ['Requested Time'],
          note: ['Request Note', 'Change Note'],
        };
        const observed = Object.fromEntries(Object.keys(attributes).map((key) => [key, []]));
        for (const candidate of nodes) {
          for (const [key, aliases] of Object.entries(attributes))
            for (const alias of aliases)
              if (candidate.hasAttribute?.(alias))
                observed[key].push(clean(candidate.getAttribute(alias)));
          for (const attribute of ['title', 'data-content', 'data-original-title']) {
            if (!candidate.hasAttribute?.(attribute)) continue;
            const rawContent = candidate.getAttribute(attribute);
            if (typeof rawContent !== 'string' || rawContent.length > 4000)
              throw new Error('timecard_provenance_invalid');
            const content = decode(rawContent);
            if (content.length > 4000) throw new Error('timecard_provenance_invalid');
            for (const line of content.split(/\n+/).map(clean).filter(Boolean)) {
              for (const [key, aliases] of Object.entries(labels))
                for (const alias of aliases)
                  if (line.startsWith(`${alias}:`))
                    observed[key].push(clean(line.slice(alias.length + 1)));
            }
          }
        }
        return normalizeRequestDetail(observed);
      };
      const change = directChange();
      const node = element.querySelector('[title*="Actual:"]');
      const raw = node?.getAttribute('title');
      if (!raw)
        return {
          ordinal: 0,
          rowIndex,
          slot,
          kind: '',
          displayTime,
          actualTime: '',
          roundedTime: '',
          clockName: '',
          clockCode: '',
          comment: '',
          provenanceAvailable: false,
          changeRequestStatus,
          approved,
          ...change,
        };
      const text = decode(raw);
      const lines = text.split(/\n+/).map(clean).filter(Boolean);
      const first = lines[0] || '';
      const sourceKind =
        (first.match(/^(IN DAY|OUT LUNCH|IN LUNCH|OUT DAY|OUT BREAK|IN BREAK)\b/i) ||
          [])[1]?.toUpperCase() || '';
      const kind =
        sourceKind === 'OUT BREAK'
          ? 'OUT LUNCH'
          : sourceKind === 'IN BREAK'
            ? 'IN LUNCH'
            : sourceKind;
      const field = (name) => {
        const line = lines.find((item) => item.toLowerCase().startsWith(name.toLowerCase() + ':'));
        return line ? clean(line.slice(name.length + 1)) : '';
      };
      const clock = field('Clock');
      const match = clock.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      return {
        ordinal: 0,
        rowIndex,
        slot,
        kind,
        displayTime,
        actualTime: field('Actual'),
        roundedTime: field('Rounded'),
        clockName: match ? clean(match[1]) : clock,
        clockCode: match ? clean(match[2]) : '',
        comment: field('Comment'),
        provenanceAvailable: true,
        changeRequestStatus,
        approved,
        ...change,
      };
    };
    const projectRow = (row, rowIndex) => {
      const cells = Array.from(row.children);
      const unresolvedSlots = slots
        .filter(([, index]) => clean(cells[index]?.textContent) === '??')
        .map(([slot]) => slot);
      const punches = slots
        .map(([slot, index]) => parsePunch(cells[index], slot, rowIndex))
        .filter(Boolean);
      const waiver = cell(cells, 'waiver')?.querySelector('input[type=checkbox]');
      const comments = Array.from(cell(cells, 'comment')?.querySelectorAll('[title]') || [])
        .map((element) =>
          decode(element.getAttribute('title'))
            .replace(/^Comment:\s*/i, '')
            .trim(),
        )
        .filter(Boolean);
      return {
        payCode: controlValue(cell(cells, 'paycode')),
        allocation1: visible(cell(cells, 'allocation1')),
        allocation2: visible(cell(cells, 'allocation2')),
        hours: numeric(visible(cell(cells, 'hours'))),
        totalHours: numeric(visible(cell(cells, 'total_hours'))),
        dollars: numeric(visible(cell(cells, 'amount'))),
        exceptionText: visible(cell(cells, 'exception-points')),
        waiverChecked: waiver ? Boolean(waiver.checked) : null,
        comments,
        unresolvedSlots,
        punches,
      };
    };
    const dayRows = allRows.filter(isDay);
    const days = dayRows.map((row, index) => {
      const heading = dayHeader(row.children[0]?.textContent);
      const projected = projectRow(row, 0);
      projected.punches.forEach((punch, punchIndex) => {
        punch.ordinal = punchIndex + 1;
      });
      return {
        date: boundDate(row.children[0]?.textContent, config.period.dates[index] || ''),
        label: heading?.label || '',
        payCode: projected.payCode,
        allocation1: projected.allocation1,
        allocation2: projected.allocation2,
        hours: projected.hours,
        totalHours: projected.totalHours,
        dollars: projected.dollars,
        exceptionText: projected.exceptionText,
        waiverChecked: projected.waiverChecked,
        comments: projected.comments,
        missingPunch: projected.unresolvedSlots.length > 0,
        unresolvedSlots: [...projected.unresolvedSlots],
        punches: projected.punches,
      };
    });
    const additionalRows = [];
    const nextRowIndex = Array(14).fill(1);
    let dayIndex = -1;
    for (const row of allRows) {
      if (isDay(row)) {
        dayIndex++;
        continue;
      }
      if (
        isWeekly(row) ||
        dayIndex < 0 ||
        row.children.length !== headers.length ||
        clean(row.children[0]?.textContent) !== ''
      )
        continue;
      const rowIndex = nextRowIndex[dayIndex]++;
      const projected = projectRow(row, rowIndex);
      const day = days[dayIndex];
      const start = day.punches.length;
      projected.punches.forEach((punch, punchIndex) => {
        punch.ordinal = start + punchIndex + 1;
        day.punches.push(punch);
      });
      const unresolved = projected.unresolvedSlots.map((slot) => `${rowIndex}:${slot}`);
      day.unresolvedSlots.push(...unresolved);
      day.missingPunch = day.unresolvedSlots.length > 0;
      additionalRows.push({
        date: day.date,
        rowIndex,
        rowClass: clean(row.className),
        payCode: projected.payCode,
        allocation1: projected.allocation1,
        allocation2: projected.allocation2,
        hours: projected.hours,
        totalHours: projected.totalHours,
        dollars: projected.dollars,
        exceptionText: projected.exceptionText,
        waiverChecked: projected.waiverChecked,
        comments: projected.comments,
        unresolvedSlots: projected.unresolvedSlots,
        punchOrdinals: projected.punches.map((punch) => punch.ordinal),
      });
    }
    const weeklyTotals = allRows
      .filter(isWeekly)
      .map((row) => numeric(row.children[1]?.textContent));
    const generic = (id) => {
      const found = document.querySelector(id);
      if (!found) return [];
      return Array.from(found.querySelectorAll(':scope > tbody > tr'))
        .map((row) => Array.from(row.children).map(visible))
        .filter((row) => row.some(Boolean) && !/^No Records Found$/i.test(row.join(' ')));
    };
    const periodTotalHours = weeklyTotals.every((item) => typeof item === 'number')
      ? Number(weeklyTotals.reduce((a, b) => a + b, 0).toFixed(2))
      : null;
    return {
      version: 2,
      sourceFormat: 'paycom-timecard-dom.v2',
      employeeCode: observedEmployeeCode,
      periodStart: config.period.start,
      periodEnd: config.period.end,
      periodKey: config.period.key,
      sourceUrl: location.href,
      pageTitle: document.title,
      headers,
      days,
      additionalRows,
      weeklyTotals,
      periodTotalHours,
      approvals: generic('#approvals-table'),
      attestations: generic('#timecard-attestation-table'),
      mealWaivers: generic('#meal-waivers-table'),
    };
  }

  const value = runtimeExtract(config, normalizeRequestDetail, resolveObservedEmployeeCode);
  validateTimecardRecord(value, config);
  return value;
};
