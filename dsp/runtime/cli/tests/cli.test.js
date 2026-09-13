'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { success, event } = require('dispatch-protocol/contracts/src');
const { parse } = require('../src/parse');
const { main } = require('../src/main');

const STATUS = success('degraded', {
  components: {
    auth: { healthy: false, status: 'stopped', data: null, error: { code: 'auth_broker_unavailable', recoverable: true } },
    collections: { healthy: true, status: 'stopped', data: { counts: { collectors: 1, sources: 1, plans: 7, queued: 0, running: 0, failed: 0 }, syncAlerts: { total: 0, critical: 0, items: [], hasMore: false } }, error: null },
    paycom: { healthy: true, status: 'ready', data: { payPeriods: { verified: true }, roster: { verified: false, code: 'not_loaded' }, timecards: { verified: false, code: 'not_loaded' } }, error: null },
  },
  summary: { ready: 1, degraded: 2, failed: 0 },
});
const SETUP = success('complete', {
  workflow: 'setup_auth', provider: 'paycom', profile: 'paycom-main', configured: true,
  broker: 'ready', vault: 'verified', authenticationTest: 'authenticated',
  nextActions: ['run_collection'],
});
const REMOVED = success('complete', {
  workflow: 'setup_auth', provider: 'paycom', profile: 'paycom-main', configured: false,
  broker: 'ready', vault: 'verified', authenticationTest: 'skipped',
  nextActions: ['configure_auth_profile'],
});
const PREPARATION = success('ready', {
  workflow: 'setup_auth',
  target: { provider: 'paycom', profile: 'paycom-main' },
  state: {
    broker: { status: 'stopped', managed: false },
    vault: { status: 'ready', verified: true },
    profile: { status: 'configured', provider: 'paycom' },
    credentialIngress: 'available',
  },
  capabilities: {
    credentialActions: [
      { id: 'keep', available: true, reason: null },
      { id: 'enroll', available: false, reason: 'profile_exists' },
      { id: 'replace', available: true, reason: null },
      { id: 'remove', available: true, reason: null },
    ],
    authenticationTest: { id: 'run', available: true, reason: null },
  },
  defaults: { credentialAction: 'keep', startBroker: true, testAuthentication: false },
});

function fixture() {
  let output = '';
  let errors = '';
  let target = { provider: 'paycom', profile: 'paycom-main' };
  const authSetup = {
    prepare: async (input = {}) => {
      target = { provider: input.provider || 'paycom', profile: input.profile || 'paycom-main' };
      return success('ready', {
        ...PREPARATION.data,
        target,
        state: { ...PREPARATION.data.state, profile: { status: 'configured', provider: target.provider } },
      });
    },
    run: async (input, { events }) => {
      await events.emit(event('workflow_started', { workflow: 'setup_auth', state: 'preflight' }, { operationId: 'setup_auth_fixture' }));
      assert.equal(input.provider, target.provider);
      assert.equal(input.profile, target.profile);
      assert.equal(input.startBroker, true);
      return success('complete', { ...SETUP.data, provider: target.provider, profile: target.profile });
    },
  };
  const collections = {
    describe: async source => success('found', { source, collector: 'paycom', collectorVersion: '0.6.0', targetType: 'pay-period', timezone: 'America/Los_Angeles', selectors: ['date'], scopes: [], limits: { maxTargets: 64, maxRangeDays: 730 } }),
    preview: async request => success('previewed', {
      id: 'preview_fixture', hash: 'a'.repeat(64), generatedAt: '2026-08-26T00:00:00.000Z', request,
      normalizedSelector: request.selector, source: request.source, collector: 'paycom', collectorVersion: '0.6.0',
      targetType: 'pay-period', timezone: 'America/Los_Angeles', targetCount: 1, taskCount: 4,
      targets: [{ key: '2026-08-22', start: '2026-08-09', end: '2026-08-22' }], tasks: [],
    }),
  };
  const syncValue = {
    id: 'fixture-main-sync', plan: 'fixture-sync-plan', source: 'fixture-main', collector: 'fixture', method: 'fixture.sync',
    desiredState: 'stopped', activity: 'idle', intervalSeconds: 60, jitterSeconds: 5, overlap: 'coalesce',
    settingsSchema: { type: 'object', properties: { behavior: { type: 'string' } }, required: ['behavior'], additionalProperties: false },
    settings: { behavior: 'no_change' }, revision: 1, generation: 0, nextDueAt: null,
    lastStartedAt: null, lastSucceededAt: null, lastError: null, blocked: null,
    businessContext: { date: '2026-08-29', timezone: 'America/Los_Angeles' }, alerts: [],
    activeRun: null, queuedRunCount: 0, createdAt: 1, updatedAt: 1,
  };
  const sync = {
    list: async () => success('found', { items: [syncValue], total: 1, limit: 50, offset: 0, hasMore: false }),
    status: async () => success('found', syncValue),
    start: async () => success('started', { sync: { ...syncValue, desiredState: 'running', activity: 'queued', generation: 1 }, run: null }),
    stop: async () => success('stopped', syncValue),
    restart: async () => success('restarted', { sync: { ...syncValue, desiredState: 'running', activity: 'queued', generation: 1 }, run: null }),
    runNow: async () => success('queued', { sync: { ...syncValue, desiredState: 'running', activity: 'queued' }, run: null }),
    edit: async (_id, patch) => success('updated', { sync: { ...syncValue, ...patch, revision: 2 }, run: null }),
    history: async (_id, options = {}) => success('found', {
      items: [], total: 0, limit: options.limit ?? 50, offset: options.offset ?? 0, hasMore: false,
    }),
  };
  const workforce = {
    snapshot: async () => success('ready', {
      target: '2026-09-05',
      collectedAt: { roster: '2026-08-29T06:00:00.000Z', timecards: '2026-08-29T06:00:00.000Z', resourceLinks: '2026-08-29T06:00:00.000Z' },
      counts: { employees: 2, timecards: 2, resourceLinks: 2 },
      lifecycleCounts: { active: 1, inactive: 0, unknown: 1 }, consistent: true,
    }),
    employees: async query => success('found', {
      kind: 'employees', target: '2026-09-05', collectedAt: '2026-08-29T06:00:00.000Z',
      items: [], total: 0, limit: query.limit, offset: query.offset, hasMore: false,
    }),
    employee: async code => success('found', {
      target: '2026-09-05', collectedAt: '2026-08-29T06:00:00.000Z',
      employee: { employeeCode: code, employeeName: 'Fixture Employee', lifecycleStatus: 'active', department: { code: 'D1', name: 'Driver' }, positionTitle: 'Driver', payClass: 'PC' },
      timecard: null,
    }),
    timecards: async query => success('found', {
      kind: 'timecards', target: '2026-09-05', collectedAt: '2026-08-29T06:00:00.000Z',
      items: [], total: 0, limit: query.limit, offset: query.offset, hasMore: false,
    }),
    punches: async query => success('found', {
      kind: 'punches', target: '2026-09-05', businessDate: query.date,
      businessTimezone: 'America/Los_Angeles', collectedAt: '2026-08-29T06:00:00.000Z',
      items: [], total: 0, limit: query.limit, offset: query.offset, hasMore: false,
    }),
    resourceLinks: async query => success('found', {
      kind: 'resource_links', target: '2026-09-05', collectedAt: '2026-08-29T06:00:00.000Z',
      items: [], total: 0, limit: query.limit, offset: query.offset, hasMore: false,
    }),
  };
  return {
    client: { system: { status: async () => STATUS }, collections, sync, workforce, workflows: { authSetup } },
    write: chunk => { output += chunk; },
    writeError: chunk => { errors += chunk; },
    values: () => ({ output, errors }),
  };
}

test('CLI parser keeps the command surface closed', () => {
  assert.deepEqual(parse(['status']), { command: 'status', format: 'plain' });
  assert.deepEqual(parse(['status', '--json']), { command: 'status', format: 'json' });
  assert.deepEqual(parse(['setup', 'auth']), {
    command: 'setup-auth', format: 'plain', provider: 'paycom', profile: 'paycom-main', replaceExisting: false, replaceSpecified: false,
    removeSpecified: false, confirmed: false,
    testAuthentication: false, testAuthenticationSpecified: false, nonInteractive: false,
  });
  assert.deepEqual(parse(['setup', 'auth', '--replace', '--test-auth', '--json']), {
    command: 'setup-auth', format: 'json', provider: 'paycom', profile: 'paycom-main', replaceExisting: true, replaceSpecified: true,
    removeSpecified: false, confirmed: false,
    testAuthentication: true, testAuthenticationSpecified: true, nonInteractive: true,
  });
  assert.equal(parse(['setup', 'auth', '--no-menu']).nonInteractive, true);
  assert.deepEqual(
    { provider: parse(['setup', 'auth', '--provider', 'amazon-logistics', '--profile', 'amazon-operations']).provider,
      profile: parse(['setup', 'auth', '--provider', 'amazon-logistics', '--profile', 'amazon-operations']).profile },
    { provider: 'amazon-logistics', profile: 'amazon-operations' },
  );
  assert.equal(parse(['setup', 'auth', '--plain']).nonInteractive, true);
  assert.throws(() => parse(['status', '--json', '--json']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['setup', 'auth', '--replace', '--replace']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['setup', 'auth', '--remove', '--json']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['setup', 'auth', '--remove', '--replace']), error => error.code === 'invalid_input');
  assert.equal(parse(['setup', 'auth', '--remove', '--confirm', '--json']).removeSpecified, true);
});

test('collection CLI uses the standard SDK request for arbitrary dates and ranges', async () => {
  assert.deepEqual(parse(['collect', 'preview', 'paycom-main', 'full', '--yesterday', '--json']), {
    command: 'collect-preview', source: 'paycom-main', scope: 'full', selector: { kind: 'relative-date', value: 'yesterday' },
    mode: 'ensure', idempotencyKey: undefined, expectedPreviewHash: undefined, format: 'json',
  });
  const range = parse(['collect', 'enqueue', 'paycom-main', 'links', '--from', '2026-07-01', '--through', '2026-07-31', '--mode', 'refresh']);
  assert.deepEqual(range.selector, { kind: 'date-range', start: '2026-07-01', end: '2026-07-31' });
  assert.equal(range.mode, 'refresh');
  const target = parse(['collect', 'target', 'cdf-example', 'cdf', '2026-W34', '--idempotency', 'cdf-W34']);
  assert.deepEqual(target.selector, { kind: 'exact-target', key: '2026-W34' });
  assert.equal(target.idempotencyKey, 'cdf-W34');
  const backfill = parse(['collect', 'backfill', 'cdf-example', 'cdf', '2026-W20', '2026-W34', '--mode', 'ensure']);
  assert.deepEqual(backfill.selector, { kind: 'target-range', startKey: '2026-W20', endKey: '2026-W34' });
  assert.equal(backfill.command, 'collect-enqueue');
  assert.throws(() => parse(['collect', 'backfill', 'cdf-example', 'cdf', '2026-W20']), error => error.code === 'invalid_input');
  assert.equal(parse(['collect', 'audit', 'paycom-main', 'links', '--date', '2026-08-18']).mode, 'verify');
  assert.equal(parse(['collect', 'retry', 'batch_fixture']).command, 'collect-retry');
  assert.equal(parse(['collect', 'schedule', 'run', 'nightly']).command, 'collect-schedule-run');
  assert.throws(() => parse(['collect', 'audit', 'paycom-main', 'links', '--current', '--mode', 'refresh']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['collect', 'preview', 'paycom-main', 'full', '--current', '--date', '2026-08-18']), error => error.code === 'invalid_input');

  const io = fixture();
  assert.equal(await main(['collect', 'preview', 'paycom-main', 'full', '--date', '2026-08-18', '--json'], io), 0);
  const result = JSON.parse(io.values().output);
  assert.equal(result.status, 'previewed');
  assert.equal(result.data.request.selector.date, '2026-08-18');
});

test('sync CLI parses lifecycle and edit commands and calls only the public sync client', async () => {
  assert.deepEqual(parse(['sync', 'start', 'fixture-main-sync', '--json']), {
    command: 'sync-start', syncId: 'fixture-main-sync', drain: false, format: 'json',
  });
  assert.deepEqual(parse(['sync', 'stop', 'fixture-main-sync', '--drain']), {
    command: 'sync-stop', syncId: 'fixture-main-sync', drain: true, format: 'plain',
  });
  assert.deepEqual(parse(['sync', 'history', 'fixture-main-sync', '--limit', '100', '--offset', '50', '--json']), {
    command: 'sync-history', syncId: 'fixture-main-sync', limit: 100, offset: 50, format: 'json',
  });
  assert.deepEqual(parse(['sync', 'edit', 'fixture-main-sync', '--interval', '120', '--jitter', '10',
    '--set', 'behavior=published', '--replace-settings', '--revision', '1', '--apply-now', '--json']), {
    command: 'sync-edit', syncId: 'fixture-main-sync',
    patch: { intervalSeconds: 120, jitterSeconds: 10, settings: { behavior: 'published' }, replaceSettings: true },
    expectedRevision: 1, applyNow: true, format: 'json',
  });
  assert.throws(() => parse(['sync', 'edit', 'fixture-main-sync', '--replace-settings']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['sync', 'edit', 'fixture-main-sync']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['sync', 'edit', 'fixture-main-sync', '--interval', '60', '--interval', '120']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['sync', 'edit', 'fixture-main-sync', '--apply-now', '--apply-now', '--set', 'behavior=published']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['sync', 'status', 'fixture-main-sync', '--drain']), error => error.code === 'invalid_input');

  const io = fixture();
  assert.equal(await main(['sync', 'list', '--json'], io), 0);
  assert.equal(JSON.parse(io.values().output).data.total, 1);

  const history = fixture();
  assert.equal(await main(['sync', 'history', 'fixture-main-sync', '--limit', '100', '--offset', '50', '--json'], history), 0);
  assert.equal(JSON.parse(history.values().output).data.limit, 100);
  assert.equal(JSON.parse(history.values().output).data.offset, 50);

  const edited = fixture();
  assert.equal(await main(['sync', 'edit', 'fixture-main-sync', '--interval', '120', '--set', 'behavior=published', '--json'], edited), 0);
  const result = JSON.parse(edited.values().output);
  assert.equal(result.data.sync.intervalSeconds, 120);
  assert.equal(result.data.sync.settings.behavior, 'published');
});

test('workforce CLI exposes only public read operations with closed pagination and lifecycle filters', async () => {
  assert.deepEqual(parse(['workforce', 'status', '--json']), { command: 'workforce-status', format: 'json' });
  assert.deepEqual(parse(['workforce', 'employees', '--lifecycle', 'unknown', '--limit', '10', '--offset', '20']), {
    command: 'workforce-employees', query: { lifecycleStatus: 'unknown', limit: 10, offset: 20 }, format: 'plain',
  });
  assert.deepEqual(parse(['workforce', 'employee', 'a001']), {
    command: 'workforce-employee', employeeCode: 'A001', format: 'plain',
  });
  assert.equal(parse(['workforce', 'timecards', '--limit', '5']).command, 'workforce-timecards');
  assert.deepEqual(parse([
    'workforce', 'punches', '--date', '2026-08-30', '--kind', 'in_day', '--from-time', '10:01', '--limit', '10',
  ]), {
    command: 'workforce-punches', query: {
      date: '2026-08-30', kind: 'in_day', fromTime: '10:01', limit: 10, offset: 0,
    }, format: 'plain',
  });
  assert.equal(parse(['workforce', 'links', '--limit', '5']).command, 'workforce-links');
  assert.throws(() => parse(['workforce', 'employees', '--lifecycle', 'deleted']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['workforce', 'timecards', '--limit', '101']), error => error.code === 'invalid_input');
  assert.throws(() => parse(['workforce', 'punches', '--date', '2026-08-30', '--from-time', '25:00']), error => error.code === 'invalid_input');

  const status = fixture();
  assert.equal(await main(['workforce', 'status', '--json'], status), 0);
  assert.equal(JSON.parse(status.values().output).data.counts.employees, 2);

  const links = fixture();
  assert.equal(await main(['workforce', 'links', '--limit', '5', '--json'], links), 0);
  assert.equal(JSON.parse(links.values().output).data.kind, 'resource_links');

  const punches = fixture();
  assert.equal(await main([
    'workforce', 'punches', '--date', '2026-08-30', '--kind', 'in_day', '--from-time', '10:01', '--json',
  ], punches), 0);
  assert.equal(JSON.parse(punches.values().output).data.kind, 'punches');

  const employees = fixture();
  assert.equal(await main(['workforce', 'employees', '--lifecycle', 'unknown', '--limit', '10', '--json'], employees), 0);
  const page = JSON.parse(employees.values().output).data;
  assert.equal(page.kind, 'employees');
  assert.equal(page.limit, 10);
});

test('dispatch status renders human output from the SDK result', async () => {
  const io = fixture();
  assert.equal(await main(['status'], io), 0);
  const { output } = io.values();
  assert.equal(output.includes('◆ DISPATCH'), true);
  assert.equal(output.includes('Collection Manager'), true);
  assert.equal(output.includes('7 plans'), true);
});

test('dispatch status --json returns the exact versioned SDK result', async () => {
  const io = fixture();
  assert.equal(await main(['status', '--json'], io), 0);
  assert.deepEqual(JSON.parse(io.values().output), STATUS);
});

test('dispatch setup auth uses only the public workflow client and keeps JSON output machine-readable', async () => {
  const io = fixture();
  const original = io.client.workflows.authSetup.run;
  io.client.workflows.authSetup.run = async (input, options) => {
    assert.equal(input.credentialAction, 'replace');
    assert.equal(input.testAuthentication, true);
    return original(input, options);
  };
  assert.equal(await main(['setup', 'auth', '--replace', '--test-auth', '--json'], io), 0);
  assert.deepEqual(JSON.parse(io.values().output), SETUP);
  assert.equal(/password|username|pin\d|cookie|token/i.test(io.values().output), false);
});

test('dispatch setup auth targets Amazon Logistics only through explicit provider and profile options', async () => {
  const io = fixture();
  assert.equal(await main([
    'setup', 'auth', '--provider', 'amazon-logistics', '--profile', 'amazon-operations', '--no-menu', '--json',
  ], io), 0);
  const result = JSON.parse(io.values().output);
  assert.equal(result.data.provider, 'amazon-logistics');
  assert.equal(result.data.profile, 'amazon-operations');
  assert.equal(/password|username|cookie|token|endpoint/i.test(io.values().output), false);
});

test('dispatch setup auth plain mode renders semantic workflow events', async () => {
  const io = fixture();
  assert.equal(await main(['setup', 'auth'], io), 0);
  assert.equal(io.values().output.includes('DISPATCH / AUTH SETUP'), true);
  assert.equal(io.values().output.includes('Authentication setup complete'), true);
});

test('Amazon Logistics setup labels and routes its authentication test without Paycom wording', async () => {
  const io = fixture();
  const original = io.client.workflows.authSetup.run;
  io.client.workflows.authSetup.run = async (input, options) => {
    assert.equal(input.provider, 'amazon-logistics');
    assert.equal(input.profile, 'amazon-operations');
    assert.equal(input.testAuthentication, true);
    await options.events.emit(event('step_started', { step: 'test_authentication' }, { operationId: 'setup_auth_fixture' }));
    return original(input, options);
  };
  assert.equal(await main([
    'setup', 'auth', '--provider', 'amazon-logistics', '--profile', 'amazon-operations', '--test-auth', '--no-menu',
  ], io), 0);
  assert.equal(io.values().output.includes('Testing Amazon Logistics authentication'), true);
  assert.equal(io.values().output.includes('Testing Paycom authentication'), false);
});

test('dispatch setup auth removal requires confirmation and invokes the closed removal action', async () => {
  const io = fixture();
  let confirmation;
  io.interaction = {
    available: () => true,
    write: () => {},
    select: async () => { throw new Error('remove must not offer another action'); },
    confirm: async value => { confirmation = value; return true; },
    close: () => {},
  };
  io.client.workflows.authSetup.run = async input => {
    assert.equal(input.credentialAction, 'remove');
    assert.equal(input.testAuthentication, false);
    return REMOVED;
  };
  assert.equal(await main(['setup', 'auth', '--remove'], io), 0);
  assert.equal(confirmation.defaultValue, false);
  assert.equal(confirmation.message.includes('paycom-main'), true);
  assert.equal(io.values().output.includes('Authentication profile deleted'), true);
});

test('interactive auth setup derives actions from preparation capabilities', async () => {
  const io = fixture();
  const selected = [];
  let closed = false;
  io.interaction = {
    available: () => true,
    write: () => {},
    select: async menu => {
      selected.push(menu);
      return selected.length === 1 ? 'replace' : 'test';
    },
    confirm: async () => true,
    close: () => { closed = true; },
  };
  const original = io.client.workflows.authSetup.run;
  io.client.workflows.authSetup.run = async (input, options) => {
    assert.equal(input.credentialAction, 'replace');
    assert.equal(input.testAuthentication, true);
    return original(input, options);
  };
  assert.equal(await main(['setup', 'auth'], io), 0);
  assert.deepEqual(selected[0].options.map(option => option.value), ['keep', 'replace', 'remove']);
  assert.equal(selected.length, 2);
  assert.equal(closed, true);
});

test('interactive auth setup cancellation does not invoke the workflow', async () => {
  const io = fixture();
  let invoked = false;
  io.client.workflows.authSetup.run = async () => { invoked = true; return SETUP; };
  io.interaction = {
    available: () => true,
    write: () => {},
    select: async menu => menu.defaultValue,
    confirm: async () => false,
    close: () => {},
  };
  assert.equal(await main(['setup', 'auth'], io), 1);
  assert.equal(invoked, false);
  assert.equal(io.values().output.includes('cancelled'), true);
});

test('JSON, plain, and no-menu setup never invoke the non-secret menu adapter', async () => {
  for (const argv of [['setup', 'auth', '--json'], ['setup', 'auth', '--plain'], ['setup', 'auth', '--no-menu']]) {
    const io = fixture();
    io.interaction = {
      available: () => true,
      write: () => { throw new Error('menu invoked'); },
      select: async () => { throw new Error('menu invoked'); },
      confirm: async () => { throw new Error('menu invoked'); },
      close: () => {},
    };
    assert.equal(await main(argv, io), 0);
  }
});

test('invalid CLI arguments return a stable error and help text', async () => {
  const io = fixture();
  assert.equal(await main(['status', '--unknown'], io), 2);
  assert.equal(JSON.parse(io.values().output).status, 'invalid_input');
  assert.equal(io.values().errors.includes('Usage:'), true);
});

test('CLI sanitizes an unexpected SDK failure', async () => {
  const io = fixture();
  io.client.system.status = async () => { throw new Error('private fixture detail'); };
  assert.equal(await main(['status', '--json'], io), 1);
  const output = JSON.parse(io.values().output);
  assert.equal(output.status, 'internal_error');
  assert.equal(JSON.stringify(output).includes('private fixture detail'), false);
});
