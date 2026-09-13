'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  AccessStore,
  AccessControlService,
  createAccessInstallationActivationAuthority,
} = require('../src');
const { runManagedPaycomActivation } = require('../../../compatibility/provisioner/src/activation.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-access-activation-'));
  fs.chmodSync(root, 0o700);
  const paths = {
    databaseRoot: path.join(root, 'access-control'),
    database: path.join(root, 'access-control', 'access-control.sqlite3'),
  };
  const time = { value: Date.parse('2026-09-02T21:30:00.000Z') };
  const store = new AccessStore(paths);
  const service = new AccessControlService(store, { clock: () => new Date(time.value) });
  service.ensureLocalOrganization({
    organization: { id: 'local-dsp', name: 'EXMP' },
    site: { id: 'local-site', code: 'TST1' },
    timezone: 'America/Los_Angeles',
  });
  return { root, paths, time, store, service };
}

async function managedOwner(context) {
  const bootstrap = context.service.createPlatformBootstrap({ email: 'platform@example.test', organizationId: 'local-dsp' });
  const platform = await context.service.acceptNewUser({
    token: bootstrap.token,
    firstName: 'Platform',
    lastName: 'Owner',
    password: 'platform owner passphrase',
    confirmPassword: 'platform owner passphrase',
  });
  const created = context.service.createOrganization(platform.session, {
    idempotencyKey: 'test:organization:create:activation',
    name: 'Activation DSP',
    abbreviation: 'ACT',
    stationCode: 'TST1',
    timezone: 'America/Chicago',
    ownerEmail: 'owner@activation.test',
  });
  const owner = await context.service.acceptNewUser({
    token: created.token,
    firstName: 'Activation',
    lastName: 'Owner',
    password: 'activation owner passphrase',
    confirmPassword: 'activation owner passphrase',
  });
  const control = context.store.installationControl(created.organization.id);
  context.store.updateInstallationControl({
    organizationId: created.organization.id,
    expectedStatus: 'pending',
    expectedRevision: control.revision,
    status: 'waiting_for_provider_auth',
    revision: control.revision + 1,
    currentJobId: null,
    timestamp: context.time.value,
  });
  return { organizationId: created.organization.id, owner };
}

function runtime(time) {
  let definitionDigest = null;
  let requestDigest = null;
  return {
    verifyInfrastructure: async manifest => ({
      runtimeKey: manifest.runtime.key,
      runtime_layout: true,
      service_supervision: true,
      auth_broker: true,
      collection_manager: true,
      runtime_gateway: true,
    }),
    configure: async definition => {
      definitionDigest = definition.digest;
      return {
        digest: definition.digest,
        collectors: 1,
        sources: 1,
        plans: 15,
        syncs: 1,
      };
    },
    testProvider: async profileId => ({
      profileId,
      provider: 'paycom',
      status: 'authenticated',
      testedAt: new Date(time.value).toISOString(),
    }),
    publishFirst: async request => {
      requestDigest = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
      return {
        batchId: 'batch_activation_001',
        preparationRunId: 'run_periods',
        status: 'succeeded',
        runCount: 5,
        succeededRuns: 5,
        failedRuns: 0,
        cancelledRuns: 0,
      };
    },
    verifyPublication: async batchId => ({
      definitionDigest,
      requestDigest,
      previewDigest: 'a'.repeat(64),
      batchId,
      preparationRunId: 'run_periods',
      target: '2026-09-05',
      runs: [
        { id: 'run_roster', taskId: 'roster', plan: 'paycom-period-roster', method: 'roster.period' },
        { id: 'run_timecards', taskId: 'timecards', plan: 'paycom-period-timecards-from-roster', method: 'timecards.from-published-roster' },
        { id: 'run_timecards_audit', taskId: 'timecards-audit', plan: 'paycom-period-timecards-audit', method: 'timecards.audit' },
        { id: 'run_links', taskId: 'links', plan: 'paycom-period-resource-links', method: 'resource-links.period' },
        { id: 'run_links_audit', taskId: 'links-audit', plan: 'paycom-period-resource-links-audit', method: 'resource-links.audit' },
      ],
      publications: {
        payPeriods: { id: 'pub_periods', runId: 'run_periods', originRunId: 'run_periods', contentSha256: '1'.repeat(64), batchBound: false },
        roster: { id: 'pub_roster', runId: 'run_roster', originRunId: 'run_roster', contentSha256: '2'.repeat(64), batchBound: true },
        timecards: { id: 'pub_timecards', runId: 'run_timecards', originRunId: 'run_timecards', contentSha256: '3'.repeat(64), batchBound: true },
        resourceLinks: { id: 'pub_links', runId: 'run_links', originRunId: 'run_links', contentSha256: '4'.repeat(64), batchBound: true },
      },
      capturedAt: new Date(time.value).toISOString(),
    }),
  };
}

test('Access Control atomically binds provider activation to owner, runtime, job, and readiness evidence', async () => {
  const context = fixture();
  try {
    const { organizationId, owner } = await managedOwner(context);
    const authority = createAccessInstallationActivationAuthority({
      store: context.store,
      organizationId,
      authorityScope: 'platform_activation',
      idempotencyKey: 'activation:fixture:0001',
      workerId: 'worker_activation_a',
      clock: () => context.time.value,
      leaseMs: 10_000,
      jobFactory: () => 'job_activation_001',
      releaseId: 'dispatch_fixture_1',
    });
    const result = await runManagedPaycomActivation({ authority, runtime: runtime(context.time) });
    assert.deepEqual(result, {
      ok: true,
      status: 'ready',
      state: 'ready',
      revision: 4,
      manifestRevision: 1,
      gates: 9,
    });
    assert.equal(context.store.installationControl(organizationId).status, 'ready');
    assert.equal(context.store.organization(organizationId).status, 'active');
    assert.equal(context.service.runtimeFor(owner.session, 'workforce.read').installation.runtimeKey.startsWith('runtime_'), true);
    const job = context.store.activationJob('job_activation_001');
    assert.equal(job.status, 'succeeded');
    assert.equal(job.installation_state, 'ready');
    assert.equal(job.failure_code, null);
    assert.match(job.evidence_digest, /^[a-f0-9]{64}$/);
    const evidence = JSON.parse(job.evidence_json);
    assert.equal(evidence.jobId, job.id);
    assert.equal(evidence.batchId, 'batch_activation_001');
    assert.equal(evidence.evidenceDigest, job.evidence_digest);
    assert.equal((await authority.inspect()).installation.state, 'ready');
  } finally {
    context.store.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('a durable setup lease fences credential mutation and activation across workers', async () => {
  const context = fixture();
  try {
    const { organizationId } = await managedOwner(context);
    const common = {
      store: context.store,
      organizationId,
      authorityScope: 'platform_activation',
      clock: () => context.time.value,
      leaseMs: 10_000,
      setupLeaseMs: 10_000,
      releaseId: 'dispatch_fixture_1',
    };
    const first = createAccessInstallationActivationAuthority({
      ...common,
      idempotencyKey: 'activation:fixture:setup:a',
      workerId: 'worker_setup_a',
      jobFactory: () => 'job_setup_blocked_a',
    });
    const second = createAccessInstallationActivationAuthority({
      ...common,
      idempotencyKey: 'activation:fixture:setup:b',
      workerId: 'worker_setup_b',
      jobFactory: () => 'job_setup_blocked_b',
    });
    const activation = createAccessInstallationActivationAuthority({
      ...common,
      idempotencyKey: 'activation:fixture:setup:activate',
      workerId: 'worker_activation_c',
      jobFactory: () => 'job_setup_activation_c',
    });
    assert.throws(() => first.guard(() => true), /installation_operation_in_progress/);
    first.beginSetup();
    assert.deepEqual(context.store.installationSetup(organizationId), {
      workerId: 'worker_setup_a', fence: 1, leaseExpiresAt: context.time.value + 10_000,
    });
    assert.throws(() => second.beginSetup(), /installation_operation_in_progress/);
    assert.throws(() => activation.begin({
      profileId: 'paycom-main', provider: 'paycom', status: 'authenticated',
      testedAt: new Date(context.time.value).toISOString(),
    }), /installation_operation_in_progress/);
    assert.equal(first.guard(() => 'mutated'), 'mutated');

    context.time.value += 10_001;
    second.beginSetup();
    assert.equal(context.store.installationSetup(organizationId).fence, 2);
    assert.throws(() => first.guard(() => true), /installation_operation_in_progress/);
    second.endSetup();
    const running = activation.begin({
      profileId: 'paycom-main', provider: 'paycom', status: 'authenticated',
      testedAt: new Date(context.time.value).toISOString(),
    });
    assert.equal(running.installation.state, 'verifying');
    assert.equal(context.store.installationSetup(organizationId).workerId, null);
  } finally {
    context.store.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('an expired activation claim is fenced before stale completion', async () => {
  const context = fixture();
  try {
    const { organizationId } = await managedOwner(context);
    const common = {
      store: context.store,
      organizationId,
      authorityScope: 'platform_activation',
      idempotencyKey: 'activation:fixture:0002',
      clock: () => context.time.value,
      leaseMs: 10_000,
      jobFactory: () => 'job_activation_002',
      releaseId: 'dispatch_fixture_1',
    };
    const first = createAccessInstallationActivationAuthority({ ...common, workerId: 'worker_activation_a' });
    const initial = await first.inspect();
    const running = await first.begin({
      profileId: 'paycom-main', provider: 'paycom', status: 'authenticated',
      testedAt: new Date(context.time.value).toISOString(),
    });
    assert.equal(initial.installation.state, 'waiting_for_provider_auth');
    assert.equal(running.installation.state, 'verifying');

    const replacement = createAccessInstallationActivationAuthority({ ...common, workerId: 'worker_activation_b' });
    const observed = await replacement.peek();
    assert.equal(observed.installation.state, 'verifying');
    assert.equal(context.store.activationJob('job_activation_002').worker_id, 'worker_activation_a');
    assert.equal(context.store.activationJob('job_activation_002').fence, 1);

    context.time.value += 10_001;
    const reclaimed = await replacement.inspect();
    assert.equal(reclaimed.job.id, 'job_activation_002');
    assert.throws(() => first.fail('job_activation_002', { code: 'first_publication_failed' }),
      /installation_operation_in_progress/);
    const failed = await replacement.fail('job_activation_002', { code: 'first_publication_failed' });
    assert.equal(failed.status, 'failed');
    assert.equal(context.store.installationControl(organizationId).status, 'failed');
    const retry = await replacement.retry();
    assert.equal(retry.installation.state, 'waiting_for_provider_auth');
    assert.equal(retry.installation.currentJobId, null);
  } finally {
    context.store.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('schema version 2 installation bindings migrate conservatively to the full lifecycle', () => {
  const context = fixture();
  const local = context.store.installationControl('local-dsp');
  assert.equal(local.status, 'ready');
  context.store.close();
  const db = new DatabaseSync(context.paths.database);
  try {
    db.exec(`INSERT INTO organizations(id,name,abbreviation,timezone,status,created_at,updated_at)
        VALUES('org_unverified_ready','Unverified Ready','UR','America/Los_Angeles','setup_required',1000,1000);
      INSERT INTO stations(organization_id,code,is_primary,created_at)
        VALUES('org_unverified_ready','BAD1',1,1000);
      INSERT INTO installations(
        organization_id,runtime_key,status,revision,manifest_revision,current_job_id,created_at,updated_at
      ) VALUES('org_unverified_ready','runtime_unverified_ready','ready',1,1,NULL,1000,1000);
      PRAGMA foreign_keys=OFF;
      DROP INDEX one_running_installation_activation;
      DROP TABLE installation_activation_jobs;
      DROP INDEX one_active_installation_provisioning;
      DROP TABLE installation_provisioning_requests;
      ALTER TABLE installations RENAME TO installations_v3;
      CREATE TABLE installations (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        runtime_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending','ready','disabled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO installations(organization_id,runtime_key,status,created_at,updated_at)
        SELECT organization_id,runtime_key,status,created_at,updated_at FROM installations_v3;
      DROP TABLE installations_v3;
      PRAGMA user_version=2;
      PRAGMA foreign_keys=ON;`);
  } finally { db.close(); }
  const migrated = new AccessStore(context.paths);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
    assert.deepEqual(migrated.installationControl('local-dsp'), {
      organizationId: 'local-dsp',
      runtimeKey: 'local',
      status: 'ready',
      revision: 1,
      manifestRevision: 1,
      releaseId: 'dispatch_current_1',
      currentJobId: null,
    });
    assert.equal(migrated.installationBackend('local-dsp'), 'local_reference');
    assert.equal(migrated.installationBackend('org_unverified_ready'), 'systemd_user');
    assert.throws(() => migrated.db.prepare("UPDATE installations SET backend='oci_container_v1' WHERE organization_id='org_unverified_ready'").run(),
      /installation_backend_immutable/);
    assert.equal(migrated.installationControl('org_unverified_ready').status, 'failed');
  } finally {
    migrated.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('schema version 4 upgrades add lifecycle, backup, release, and Runtime Agent authority tables', () => {
  const context = fixture();
  context.store.close();
  const legacy = new DatabaseSync(context.paths.database);
  try {
    legacy.exec(`
      DROP INDEX installation_backups_by_organization;
      DROP TABLE installation_backups;
      DROP INDEX one_active_installation_lifecycle;
      DROP TABLE installation_lifecycle_jobs;
      DROP TRIGGER installations_backend_immutable;
      ALTER TABLE installations DROP COLUMN release_id;
      ALTER TABLE installations DROP COLUMN backend;
      PRAGMA user_version=4;
    `);
  } finally { legacy.close(); }

  const migrated = new AccessStore(context.paths);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
    assert.equal(migrated.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('installation_lifecycle_jobs','installation_backups')").get().count, 2);
    assert.equal(migrated.installationControl('local-dsp').releaseId, 'dispatch_current_1');
    assert.equal(migrated.installationBackend('local-dsp'), 'local_reference');
    assert.equal(migrated.installationControl('local-dsp').status, 'ready');
  } finally {
    migrated.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});
