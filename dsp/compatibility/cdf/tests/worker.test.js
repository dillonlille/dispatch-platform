'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runCollector, validateReceipt } = require('dispatch-runtime-kit/collection-manager/src/runner');
const { authenticationState, execute, safeFailure } = require('../src/collector');
const { stageCollection } = require('../src/artifacts');

const command = path.join(__dirname, "./fixture-worker");
const runtime = path.join(__dirname, ".fixture-runtime");

function request(id, method = 'cdf.week.collect') {
  return {
    id,
    plan_id: method === 'cdf.week.audit' ? 'cdf-week-audit' : 'cdf-week',
    source_id: 'cdf-example',
    collector_id: 'cdf',
    auth_profile: 'amazon-example',
    sourceConfig: {
      timezone: 'America/Los_Angeles', station: 'TST1', companyId: 'fixture-company', dsp: 'fixture-dsp',
    },
    method_id: method,
    input: method === 'cdf.week.collect' ? { week: '2026-W20', replace: false } : { week: '2026-W20' },
    attempt: 1,
    timeout_seconds: 30,
    command,
  };
}

function healthRequest() {
  return {
    protocolVersion: 1,
    runId: 'run_health',
    plan: 'cdf-health',
    source: {
      id: 'cdf-example', collector: 'cdf', authProfile: 'amazon-operations',
      config: { timezone: 'America/Los_Angeles', station: 'TST1', companyId: 'fixture-company', dsp: 'fixture-dsp' },
    },
    method: 'collector.health', input: {}, attempt: 1,
    deadline: '2099-08-29T13:00:00.000Z',
  };
}

test('CDF health reports closed Auth Broker readiness without acquiring a browser', async () => {
  const calls = [];
  const manual = await authenticationState('amazon-operations', {
    socketPath: '/fixture/broker.sock',
    request: async (socket, payload, options) => {
      calls.push({ socket, payload, options });
      return {
        ok: true, status: 'configured',
        profile: { configured: true }, session: 'manual_verification_required',
      };
    },
  });
  assert.equal(manual, 'manual_verification_required');
  assert.deepEqual(calls[0].payload, { action: 'status', profile: 'amazon-operations' });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cdf-health-'));
  fs.chmodSync(root, 0o700);
  try {
    const receipt = await execute(healthRequest(), {
      database: path.join(root, 'missing.sqlite3'),
      artifactRoot: path.join(root, 'artifacts'),
      stagingRoot: path.join(root, '.staging'),
      authenticationProbe: async () => manual,
    });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.data.storage, 'not_initialized');
    assert.equal(receipt.data.authenticationState, 'manual_verification_required');
    assert.equal(receipt.data.collection, 'manual_verification_required');
    assert.doesNotThrow(() => validateReceipt(receipt));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the real Collection Manager worker accepts publish, no-change, and audit receipts', async () => {
  fs.rmSync(runtime, { recursive: true, force: true });
  try {
    const first = await runCollector(request('run_manager_first')).promise;
    assert.equal(first.success, true);
    assert.equal(first.receipt.status, 'published');
    assert.equal(first.receipt.data.rowCount, 1);
    assert.equal(first.receipt.data.providerLinkCount, 1);
    const replay = await runCollector(request('run_manager_replay')).promise;
    assert.equal(replay.success, true);
    assert.equal(replay.receipt.status, 'no_change');
    const lateWindowAttempt = await runCollector({
      ...request('run_manager_attempt_96'), attempt: 96,
    }).promise;
    assert.equal(lateWindowAttempt.success, true);
    assert.equal(lateWindowAttempt.receipt.status, 'no_change');
    const audit = await runCollector(request('run_manager_audit', 'cdf.week.audit')).promise;
    assert.equal(audit.success, true);
    assert.equal(audit.receipt.status, 'succeeded');
    assert.equal(audit.receipt.data.verified, true);
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
});

test('auxiliary provider-link failure publishes valid CDF data with a sanitized warning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cdf-degraded-'));
  fs.chmodSync(root, 0o700);
  try {
    const stagingRoot = path.join(root, '.staging');
    const csvBytes = fs.readFileSync(path.join(__dirname, "./fixtures/2026-W20.csv"));
    const providerBytes = fs.readFileSync(path.join(__dirname, "./fixtures/2026-W20-providers.json"));
    stageCollection({
      stagingRoot, runId: 'run_interrupted', attempt: 1, week: '2026-W20', station: 'TST1',
      companyId: 'fixture-company', dsp: 'fixture-dsp', collectedAt: '2026-08-29T11:00:00.000Z',
      csvBytes, providerBytes, providerStatus: 'ready',
    });
    assert.equal(fs.readdirSync(stagingRoot).length, 1);
    const receipt = await execute({
      protocolVersion: 1,
      runId: 'run_degraded_links',
      plan: 'cdf-week-collect',
      source: {
        id: 'cdf-example',
        collector: 'cdf',
        authProfile: 'amazon-example',
        config: { timezone: 'America/Los_Angeles', station: 'TST1', companyId: 'fixture-company', dsp: 'fixture-dsp' },
      },
      method: 'cdf.week.collect',
      input: { week: '2026-W20', replace: false },
      attempt: 1,
      deadline: '2099-08-29T13:00:00.000Z',
    }, {
      database: path.join(root, 'cdf.sqlite3'),
      artifactRoot: path.join(root, 'artifacts'),
      stagingRoot,
      fetchArtifacts: async () => ({
        csvBytes,
        providerBytes: null,
      }),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    });
    assert.equal(receipt.status, 'published');
    assert.deepEqual(receipt.warnings, ['provider_links_unavailable']);
    assert.equal(receipt.data.providerLinks, 'degraded');
    assert.equal(receipt.data.providerLinkCount, 0);
    assert.equal(receipt.data.verified, true);
    assert.equal(fs.readdirSync(stagingRoot).length, 0);
    assert.doesNotThrow(() => validateReceipt(receipt));
    assert.equal(JSON.stringify(receipt).includes(root), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an expired post-fetch deadline cannot stage or publish', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cdf-deadline-'));
  fs.chmodSync(root, 0o700);
  const database = path.join(root, 'cdf.sqlite3');
  try {
    const deadline = new Date(Date.now() + 300).toISOString();
    await assert.rejects(execute({
      protocolVersion: 1,
      runId: 'run_deadline',
      plan: 'cdf-week-collect',
      source: {
        id: 'cdf-example',
        collector: 'cdf',
        authProfile: 'amazon-example',
        config: { timezone: 'America/Los_Angeles', station: 'TST1', companyId: 'fixture-company', dsp: 'fixture-dsp' },
      },
      method: 'cdf.week.collect',
      input: { week: '2026-W20', replace: false },
      attempt: 1,
      deadline,
    }, {
      database,
      artifactRoot: path.join(root, 'artifacts'),
      stagingRoot: path.join(root, '.staging'),
      fetchArtifacts: async () => {
        await new Promise(resolve => setTimeout(resolve, 400));
        return {
          csvBytes: fs.readFileSync(path.join(__dirname, "./fixtures/2026-W20.csv")),
          providerBytes: fs.readFileSync(path.join(__dirname, "./fixtures/2026-W20-providers.json")),
        };
      },
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    }), error => error.code === 'deadline_exceeded');
    assert.equal(fs.existsSync(database), false);
    assert.deepEqual(safeFailure(Object.assign(new Error('artifact_invalid'), { code: 'artifact_invalid' })), {
      ok: false, status: 'failed', data: null, error: { code: 'artifact_invalid' },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
