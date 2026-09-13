'use strict';

function invalid() { throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' }); }

function parseOptions(options, allowed) {
  if (new Set(options).size !== options.length || options.some(value => !allowed.includes(value))
      || options.includes('--json') && options.includes('--plain')) invalid();
  return { format: options.includes('--json') ? 'json' : 'plain' };
}

function flags(values, booleanNames, valueNames) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (Object.hasOwn(result, name) || !booleanNames.includes(name) && !valueNames.includes(name)) invalid();
    if (booleanNames.includes(name)) result[name] = true;
    else {
      const value = values[++index];
      if (value === undefined || value.startsWith('--')) invalid();
      result[name] = value;
    }
  }
  if (result['--json'] && result['--plain']) invalid();
  return result;
}

function selectorFrom(options) {
  const candidates = [
    options['--current'] && { kind: 'current' },
    options['--latest-complete'] && { kind: 'latest-complete' },
    options['--today'] && { kind: 'relative-date', value: 'today' },
    options['--yesterday'] && { kind: 'relative-date', value: 'yesterday' },
    options['--date'] && { kind: 'date', date: options['--date'] },
    options['--from'] && options['--through'] && { kind: 'date-range', start: options['--from'], end: options['--through'] },
    options['--last-days'] && { kind: 'last-duration', value: Number(options['--last-days']), unit: 'days' },
    options['--target'] && { kind: 'exact-target', key: options['--target'] },
    options['--from-target'] && options['--through-target'] && {
      kind: 'target-range', startKey: options['--from-target'], endKey: options['--through-target'],
    },
  ].filter(Boolean);
  if (candidates.length !== 1 || Boolean(options['--from']) !== Boolean(options['--through'])
      || Boolean(options['--from-target']) !== Boolean(options['--through-target'])) invalid();
  return candidates[0];
}

const SELECTOR_BOOLEANS = ['--current', '--latest-complete', '--today', '--yesterday'];
const SELECTOR_VALUES = ['--date', '--from', '--through', '--last-days', '--target', '--from-target', '--through-target'];

function parseCollection(argv) {
  const [action, ...args] = argv;
  if (action === 'describe' && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain'], []);
    return { command: 'collect-describe', source: args[0], format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'target' && args.length >= 3) {
    const options = flags(args.slice(3), ['--json', '--plain'], ['--mode', '--idempotency', '--preview-hash']);
    return {
      command: 'collect-enqueue', source: args[0], scope: args[1], selector: { kind: 'exact-target', key: args[2] },
      mode: options['--mode'] || 'ensure', idempotencyKey: options['--idempotency'], expectedPreviewHash: options['--preview-hash'],
      format: options['--json'] ? 'json' : 'plain',
    };
  }
  if (action === 'backfill' && args.length >= 4) {
    const options = flags(args.slice(4), ['--json', '--plain'], ['--mode', '--idempotency', '--preview-hash']);
    return {
      command: 'collect-enqueue', source: args[0], scope: args[1],
      selector: { kind: 'target-range', startKey: args[2], endKey: args[3] },
      mode: options['--mode'] || 'ensure', idempotencyKey: options['--idempotency'], expectedPreviewHash: options['--preview-hash'],
      format: options['--json'] ? 'json' : 'plain',
    };
  }
  if (['preview', 'enqueue', 'audit'].includes(action) && args.length >= 2) {
    const options = flags(args.slice(2), [...SELECTOR_BOOLEANS, '--json', '--plain'], [...SELECTOR_VALUES, '--mode', '--idempotency', '--preview-hash']);
    if (options['--json'] && options['--plain'] || action === 'audit' && options['--mode']) invalid();
    return {
      command: `collect-${action}`, source: args[0], scope: args[1], selector: selectorFrom(options),
      mode: action === 'audit' ? 'verify' : options['--mode'] || 'ensure', idempotencyKey: options['--idempotency'], expectedPreviewHash: options['--preview-hash'],
      format: options['--json'] ? 'json' : 'plain',
    };
  }
  if (action === 'batch' && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain'], []);
    return { command: 'collect-batch', batchId: args[0], format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'batches') {
    const options = flags(args, ['--json', '--plain'], []);
    return { command: 'collect-batches', format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'cancel' && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain'], []);
    return { command: 'collect-cancel', batchId: args[0], format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'retry' && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain'], []);
    return { command: 'collect-retry', batchId: args[0], format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'schedules') {
    const options = flags(args, ['--json', '--plain'], []);
    return { command: 'collect-schedules', format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'schedule' && ['pause', 'resume', 'remove', 'run'].includes(args[0]) && args.length >= 2) {
    const options = flags(args.slice(2), ['--json', '--plain'], []);
    return { command: `collect-schedule-${args[0]}`, scheduleId: args[1], format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'schedule' && args[0] === 'create' && args.length >= 4) {
    const options = flags(args.slice(4), [...SELECTOR_BOOLEANS, '--json', '--plain'], [...SELECTOR_VALUES, '--mode', '--interval', '--cron', '--timezone']);
    if (options['--json'] && options['--plain'] || Boolean(options['--interval']) === Boolean(options['--cron'])) invalid();
    const schedule = options['--interval']
      ? { type: 'interval', seconds: Number(options['--interval']) }
      : { type: 'cron', expression: options['--cron'], timezone: options['--timezone'] };
    if (schedule.type === 'cron' && !schedule.timezone) invalid();
    return {
      command: 'collect-schedule-create', scheduleId: args[1], source: args[2], scope: args[3], selector: selectorFrom(options),
      mode: options['--mode'] || 'ensure', schedule, format: options['--json'] ? 'json' : 'plain',
    };
  }
  invalid();
}

function parseSyncSetting(value) {
  if (typeof value !== 'string') invalid();
  const index = value.indexOf('=');
  if (index < 1) invalid();
  const key = value.slice(0, index);
  const raw = value.slice(index + 1);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || raw.length === 0) invalid();
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch {}
  if (!['string', 'number', 'boolean'].includes(typeof parsed) || typeof parsed === 'number' && !Number.isFinite(parsed)) invalid();
  return [key, parsed];
}

function parseSync(argv) {
  const [action, ...args] = argv;
  if (action === 'list') {
    const options = flags(args, ['--json', '--plain'], []);
    return { command: 'sync-list', format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'history' && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain'], ['--limit', '--offset']);
    const limit = options['--limit'] === undefined ? 50 : Number(options['--limit']);
    const offset = options['--offset'] === undefined ? 0 : Number(options['--offset']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) invalid();
    return {
      command: 'sync-history', syncId: args[0], limit, offset,
      format: options['--json'] ? 'json' : 'plain',
    };
  }
  if (['status', 'start', 'stop', 'restart', 'run'].includes(action) && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain', '--drain'], []);
    if (options['--drain'] && !['stop', 'restart'].includes(action)) invalid();
    return {
      command: `sync-${action}`, syncId: args[0], drain: Boolean(options['--drain']),
      format: options['--json'] ? 'json' : 'plain',
    };
  }
  if (action === 'edit' && args.length >= 1) {
    const syncId = args[0];
    const values = args.slice(1);
    const patch = {};
    const settings = {};
    let expectedRevision;
    let applyNow = false;
    let replaceSettings = false;
    let format = 'plain';
    const seenFlags = new Set();
    for (let index = 0; index < values.length; index += 1) {
      const name = values[index];
      if (name !== '--set' && seenFlags.has(name)) invalid();
      seenFlags.add(name);
      if (name === '--json' || name === '--plain' || name === '--apply-now' || name === '--replace-settings') {
        if (name === '--json') format = 'json';
        else if (name === '--plain') format = 'plain';
        else if (name === '--apply-now') applyNow = true;
        else {
          if (replaceSettings) invalid();
          replaceSettings = true;
        }
        continue;
      }
      const value = values[++index];
      if (value === undefined || value.startsWith('--')) invalid();
      if (name === '--interval') patch.intervalSeconds = Number(value);
      else if (name === '--jitter') patch.jitterSeconds = Number(value);
      else if (name === '--revision') expectedRevision = Number(value);
      else if (name === '--set') {
        const [key, setting] = parseSyncSetting(value);
        if (Object.hasOwn(settings, key)) invalid();
        settings[key] = setting;
      } else invalid();
    }
    if (values.includes('--json') && values.includes('--plain')) invalid();
    if (replaceSettings && Object.keys(settings).length === 0) invalid();
    if (Object.keys(settings).length) patch.settings = settings;
    if (replaceSettings) patch.replaceSettings = true;
    if (Object.keys(patch).length === 0) invalid();
    return { command: 'sync-edit', syncId, patch, expectedRevision, applyNow, format };
  }
  invalid();
}

function parseWorkforceQuery(values) {
  const options = flags(values, ['--json', '--plain'], ['--lifecycle', '--limit', '--offset']);
  const limit = options['--limit'] === undefined ? 50 : Number(options['--limit']);
  const offset = options['--offset'] === undefined ? 0 : Number(options['--offset']);
  const lifecycleStatus = options['--lifecycle'];
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0
      || lifecycleStatus !== undefined && !['active', 'inactive', 'unknown'].includes(lifecycleStatus)) invalid();
  return {
    query: { limit, offset, ...(lifecycleStatus === undefined ? {} : { lifecycleStatus }) },
    format: options['--json'] ? 'json' : 'plain',
  };
}

function parseWorkforcePunches(values) {
  const options = flags(values, ['--json', '--plain'], [
    '--date', '--kind', '--from-time', '--through-time', '--lifecycle', '--limit', '--offset',
  ]);
  const date = options['--date'];
  const kind = options['--kind'];
  const fromTime = options['--from-time'];
  const throughTime = options['--through-time'];
  const lifecycleStatus = options['--lifecycle'];
  const limit = options['--limit'] === undefined ? 50 : Number(options['--limit']);
  const offset = options['--offset'] === undefined ? 0 : Number(options['--offset']);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || kind !== undefined && !['in_day', 'out_lunch', 'in_lunch', 'out_day', 'unclassified'].includes(kind)
      || fromTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fromTime)
      || throughTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(throughTime)
      || fromTime !== undefined && throughTime !== undefined && fromTime > throughTime
      || lifecycleStatus !== undefined && !['active', 'inactive', 'unknown'].includes(lifecycleStatus)
      || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) invalid();
  return {
    command: 'workforce-punches',
    query: {
      date, limit, offset,
      ...(kind === undefined ? {} : { kind }),
      ...(fromTime === undefined ? {} : { fromTime }),
      ...(throughTime === undefined ? {} : { throughTime }),
      ...(lifecycleStatus === undefined ? {} : { lifecycleStatus }),
    },
    format: options['--json'] ? 'json' : 'plain',
  };
}

function parseWorkforce(argv) {
  const [action, ...args] = argv;
  if (action === 'status') {
    const options = flags(args, ['--json', '--plain'], []);
    return { command: 'workforce-status', format: options['--json'] ? 'json' : 'plain' };
  }
  if (action === 'punches') return parseWorkforcePunches(args);
  if (['employees', 'timecards', 'links'].includes(action)) {
    return { command: `workforce-${action}`, ...parseWorkforceQuery(args) };
  }
  if (action === 'employee' && args.length >= 1) {
    const options = flags(args.slice(1), ['--json', '--plain'], []);
    if (!/^[A-Za-z0-9]{4}$/.test(args[0])) invalid();
    return { command: 'workforce-employee', employeeCode: args[0].toUpperCase(), format: options['--json'] ? 'json' : 'plain' };
  }
  invalid();
}

function parse(argv) {
  if (!Array.isArray(argv)) invalid();
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) return { command: 'help', format: 'plain' };
  if (argv[0] === 'status') {
    const parsed = parseOptions(argv.slice(1), ['--json', '--plain']);
    return { command: 'status', ...parsed };
  }
  if (argv[0] === 'setup' && argv[1] === 'auth') {
    const options = argv.slice(2);
    const values = flags(options,
      ['--json', '--plain', '--replace', '--remove', '--confirm', '--test-auth', '--no-menu'],
      ['--provider', '--profile']);
    const format = values['--json'] ? 'json' : 'plain';
    const replaceSpecified = Boolean(values['--replace']);
    const removeSpecified = Boolean(values['--remove']);
    const confirmed = Boolean(values['--confirm']);
    const testAuthentication = Boolean(values['--test-auth']);
    const nonInteractive = Boolean(values['--no-menu'] || values['--plain'] || values['--json']);
    if (replaceSpecified && removeSpecified || confirmed && !removeSpecified || removeSpecified && testAuthentication
        || removeSpecified && nonInteractive && !confirmed) invalid();
    return {
      command: 'setup-auth', format, provider: values['--provider'] || 'paycom', profile: values['--profile'] || 'paycom-main',
      replaceExisting: replaceSpecified,
      replaceSpecified,
      removeSpecified,
      confirmed,
      testAuthentication,
      testAuthenticationSpecified: Boolean(values['--test-auth']),
      nonInteractive,
    };
  }
  if (argv[0] === 'collect') return parseCollection(argv.slice(1));
  if (argv[0] === 'sync') return parseSync(argv.slice(1));
  if (argv[0] === 'workforce') return parseWorkforce(argv.slice(1));
  invalid();
}

module.exports = {
  parse, parseCollection, parseSync, parseWorkforce, parseWorkforceQuery, parseWorkforcePunches, parseSyncSetting, selectorFrom,
};
