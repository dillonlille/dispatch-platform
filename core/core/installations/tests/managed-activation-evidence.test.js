'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('dispatch-dsp/runtime/collection-manager/src/manager.js');
const { LocalCollectionAdminPort } = require('dispatch-dsp/runtime/adapters/local/collection-admin-port.js');
const { LocalCollectionManagerPort } = require('dispatch-dsp/runtime/adapters/local/collection-manager-port.js');
const { CollectionClient } = require('dispatch-runtime-kit/sdk/src/collection-client');
const {
  MANAGED_RUNTIME_ENVIRONMENT_KEYS,
} = require('../../../shared/paths/runtime-paths');
const { createInstallationLayoutManager } = require('../src/layout');
const {
  PAYCOM_FIRST_PUBLICATION_TASKS,
  managedPaycomDefinition,
  managedPaycomFirstPublicationRequest,
} = require('../../../compatibility/provisioner/src/managed-paycom.js');
const {
  createManagedPaycomActivationEvidenceVerifier,
} = require('../../../compatibility/provisioner/src/managed-activation-evidence.js');

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const FIXTURE_COLLECTOR = path.join(__dirname, "./fixture-paycom-collector.js");
const FORBIDDEN_ENV = Object.freeze([
  'DISPATCH_LOCAL_ROOT',
  'DISPATCH_ACCESS_CONTROL_DATA_ROOT',
  'DISPATCH_ACCESS_CONTROL_DATABASE_ROOT',
]);

function manifest(suffix) {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: {
      id: `org_evidence_${suffix}`,
      stationCode: 'TST1',
      timezone: 'America/Los_Angeles',
    },
    runtime: {
      key: `runtime_evidence_${suffix}`,
      templateId: 'isolated_dsp_v1',
      releaseId: 'dispatch_fixture_1',
    },
  };
}
function authority(selected) {
  return {
    revision: selected.revision,
    organization: { ...selected.organization },
    runtime: { ...selected.runtime },
  };
}
function applyEnvironment(values) {
  const keys = [...MANAGED_RUNTIME_ENVIRONMENT_KEYS, 'DISPATCH_MANAGED_RUNTIME', ...FORBIDDEN_ENV];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of FORBIDDEN_ENV) delete process.env[key];
  Object.assign(process.env, values, { DISPATCH_MANAGED_RUNTIME: '1' });
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

async function collectFixtureRuntime(installationsRoot, suffix) {
  const selected = manifest(suffix);
  const selectedAuthority = authority(selected);
  const layoutManager = createInstallationLayoutManager({
    installationsRoot,
    projectRoot: PROJECT_ROOT,
  });
  layoutManager.materialize(selected, selectedAuthority);
  const paths = layoutManager.runtimePaths(selected, selectedAuthority);
  const environment = layoutManager.runtimeEnvironment(selected, selectedAuthority);
  const restoreEnvironment = applyEnvironment(environment);
  const managerStore = new CollectionStore(paths.collection);
  require('dispatch-runtime-kit/collection-manager/src/plugin-state').applyState(managerStore, { command: 'apply', pluginId: 'paycom', version: '0.18.7', state: 'enabled', revision: 1 });
  const manager = new CollectionManager(managerStore, { tickMs: 5 });
  let started = false;
  try {
    const definition = managedPaycomDefinition(selected, selectedAuthority, { projectRoot: PROJECT_ROOT });
    const fixtureSpec = JSON.parse(JSON.stringify(definition.specification));
    const fixtureExecutable = path.join(paths.configRoot, 'fixture-paycom-collector');
    const fixtureSource = fs.readFileSync(FIXTURE_COLLECTOR, 'utf8');
    assert.equal(path.isAbsolute(process.execPath), true);
    assert.doesNotMatch(process.execPath, /[\0\r\n ]/);
    fs.writeFileSync(fixtureExecutable,
      fixtureSource.replace(/^#![^\n]+/, `#!${process.execPath}`), { mode: 0o700, flag: 'wx' });
    fixtureSpec.collectors[0].command = fixtureExecutable;
    const admin = new LocalCollectionAdminPort({ paths: paths.collection });
    admin.apply(fixtureSpec);
    assert.deepEqual(admin.inspect().counts, { collectors: 1, sources: 1, plans: 15, syncs: 1 });
    assert.deepEqual(admin.attest(fixtureSpec), { matched: true });
    const driftedSpec = JSON.parse(JSON.stringify(fixtureSpec));
    driftedSpec.sources[0].config.timezone = 'America/New_York';
    assert.deepEqual(admin.attest(driftedSpec), { matched: false });
    await manager.start();
    started = true;

    const client = new CollectionClient({ port: new LocalCollectionManagerPort({ paths: paths.collection }) });
    const periods = await client.startRun('paycom-periods', {}, {
      idempotencyKey: `fixture-periods-${suffix}`,
    });
    assert.equal(periods.ok, true, JSON.stringify(periods));
    assert.equal((await manager.runUntilIdle({ timeoutMs: 10_000 })).idle, true);

    const batch = await client.enqueue(managedPaycomFirstPublicationRequest(), {
      idempotencyKey: `fixture-activation-${suffix}`,
    });
    assert.equal(batch.ok, true, JSON.stringify(batch));
    assert.equal((await manager.runUntilIdle({ timeoutMs: 20_000 })).idle, true);
    const terminal = await client.batchStatus(batch.data.id, { limit: 50, offset: 0 });
    assert.equal(terminal.status, 'succeeded', JSON.stringify(terminal));
    assert.deepEqual(terminal.data.runPage.items.map(item => item.run.plan).sort(),
      Object.keys(PAYCOM_FIRST_PUBLICATION_TASKS).sort());

    const verifier = createManagedPaycomActivationEvidenceVerifier({ environment });
    const evidence = verifier.verify({
      batchId: batch.data.id,
      preparationRunId: periods.data.id,
      definitionDigest: definition.digest,
    });
    assert.equal(evidence.batchId, batch.data.id);
    assert.equal(evidence.target, '2026-09-05');
    assert.equal(evidence.runs.length, 5);
    assert.equal(evidence.publications.payPeriods.batchBound, false);
    for (const key of ['roster', 'timecards', 'resourceLinks']) {
      assert.equal(evidence.publications[key].batchBound, true);
      assert.match(evidence.publications[key].contentSha256, /^[a-f0-9]{64}$/);
    }

    const retryPeriods = await client.startRun('paycom-periods', {}, {
      idempotencyKey: `fixture-periods-retry-${suffix}`,
    });
    assert.equal(retryPeriods.ok, true);
    assert.equal((await manager.runUntilIdle({ timeoutMs: 10_000 })).idle, true);
    const retryBatch = await client.enqueue(managedPaycomFirstPublicationRequest(), {
      idempotencyKey: `fixture-batch-retry-${suffix}`,
    });
    assert.equal(retryBatch.ok, true);
    assert.equal((await manager.runUntilIdle({ timeoutMs: 20_000 })).idle, true);

    const retryEvidence = verifier.verify({
      batchId: retryBatch.data.id,
      preparationRunId: retryPeriods.data.id,
      definitionDigest: definition.digest,
    });
    for (const key of ['payPeriods', 'roster', 'timecards', 'resourceLinks']) {
      assert.equal(retryEvidence.publications[key].id, evidence.publications[key].id);
      assert.equal(retryEvidence.publications[key].originRunId,
        evidence.publications[key].originRunId);
      assert.notEqual(retryEvidence.publications[key].runId, evidence.publications[key].runId);
    }
    return Object.freeze({ paths, environment, evidence, retryEvidence });
  } finally {
    if (started) await manager.stop();
    managerStore.close();
    restoreEnvironment();
  }
}

test('two isolated real managers produce independently bound first-publication evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-managed-evidence-'));
  fs.chmodSync(root, 0o700);
  const installationsRoot = path.join(root, 'installations');
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  try {
    const alpha = await collectFixtureRuntime(installationsRoot, 'alpha');
    const bravo = await collectFixtureRuntime(installationsRoot, 'bravo');
    assert.notEqual(alpha.paths.collection.database, bravo.paths.collection.database);
    assert.notEqual(alpha.paths.paycom.database, bravo.paths.paycom.database);
    for (const key of ['payPeriods', 'roster', 'timecards', 'resourceLinks']) {
      assert.notEqual(alpha.evidence.publications[key].id, bravo.evidence.publications[key].id);
      assert.notEqual(alpha.evidence.publications[key].runId, bravo.evidence.publications[key].runId);
    }
    const crossedEnvironment = {
      ...alpha.environment,
      ...Object.fromEntries(Object.entries(bravo.environment)
        .filter(([key]) => key.startsWith('DISPATCH_PAYCOM_'))),
    };
    const crossed = createManagedPaycomActivationEvidenceVerifier({ environment: crossedEnvironment });
    assert.throws(() => crossed.verify({
      batchId: alpha.evidence.batchId,
      preparationRunId: alpha.evidence.preparationRunId,
      definitionDigest: alpha.evidence.definitionDigest,
    }), error => error.code === 'first_publication_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
