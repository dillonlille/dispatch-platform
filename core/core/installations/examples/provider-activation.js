'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AccessStore,
  AccessControlService,
  createAccessControlLiveAuthorityResolver,
  createAccessInstallationActivationAuthority,
  createAccessInstallationProvisioningAuthority,
  createInstallationProvisioningReconciler,
} = require('../../accounts/src');
const { createDurableInstallationProvisioner } = require('../src/jobs');
const { runManagedPaycomActivation } = require('../../../compatibility/provisioner/src/activation.js');

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-activation-fixture-'));
  fs.chmodSync(root, 0o700);
  return root;
}

function artifactRuntime(installationRoot, testedAt, { failPublication = false } = {}) {
  const configFile = path.join(installationRoot, 'config', 'activation.json');
  const dataRoot = path.join(installationRoot, 'data', 'providers', 'paycom');
  const stagingRoot = path.join(installationRoot, 'staging', 'providers', 'paycom');
  const active = path.join(dataRoot, 'first-publication.json');
  let definitionDigest = null;
  let requestDigest = null;
  return Object.freeze({
    async verifyInfrastructure(manifest) {
      const info = fs.lstatSync(installationRoot);
      assert.equal(info.isDirectory(), true);
      assert.equal(info.mode & 0o7777, 0o700);
      assert.equal(path.basename(installationRoot), manifest.runtime.key);
      return {
        runtimeKey: manifest.runtime.key,
        runtime_layout: true,
        service_supervision: true,
        auth_broker: true,
        collection_manager: true,
        runtime_gateway: true,
      };
    },
    async configure(definition) {
      definitionDigest = definition.digest;
      const selected = JSON.stringify({ digest: definition.digest, collectors: 1, sources: 1, plans: 15, syncs: 1 });
      const candidate = `${configFile}.candidate`;
      fs.writeFileSync(candidate, selected, { mode: 0o600, flag: 'wx' });
      fs.renameSync(candidate, configFile);
      assert.equal(fs.readFileSync(configFile, 'utf8'), selected);
      return JSON.parse(selected);
    },
    async testProvider(profileId) {
      return { profileId, provider: 'paycom', status: 'authenticated', testedAt };
    },
    async publishFirst(request, operation) {
      requestDigest = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
      fs.mkdirSync(dataRoot, { mode: 0o700 });
      fs.mkdirSync(stagingRoot, { mode: 0o700 });
      const batchId = `batch_${path.basename(installationRoot).replace(/^runtime_/, '')}`;
      const candidate = path.join(stagingRoot, `${batchId}.json`);
      const publication = JSON.stringify({ batchId, target: '2026-09-05', idempotencyKey: operation.idempotencyKey });
      fs.writeFileSync(candidate, publication, { mode: 0o600, flag: 'wx' });
      if (failPublication) {
        fs.unlinkSync(candidate);
        return {
          batchId, preparationRunId: 'run_periods', status: 'failed', runCount: 5,
          succeededRuns: 4, failedRuns: 1, cancelledRuns: 0,
        };
      }
      fs.renameSync(candidate, active);
      assert.equal(fs.readFileSync(active, 'utf8'), publication);
      return {
        batchId, preparationRunId: 'run_periods', status: 'succeeded', runCount: 5,
        succeededRuns: 5, failedRuns: 0, cancelledRuns: 0,
      };
    },
    async verifyPublication(batchId, preparationRunId) {
      const publication = JSON.parse(fs.readFileSync(active, 'utf8'));
      return {
        definitionDigest,
        requestDigest,
        previewDigest: 'a'.repeat(64),
        batchId,
        preparationRunId,
        target: publication.target,
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
        capturedAt: testedAt,
      };
    },
  });
}

async function main() {
  const root = createRoot();
  const accessRoot = path.join(root, 'access');
  const stateRoot = path.join(root, 'control');
  const installationsRoot = path.join(root, 'installations');
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  const store = new AccessStore({
    databaseRoot: accessRoot,
    database: path.join(accessRoot, 'access-control.sqlite3'),
  });
  let now = Date.parse('2026-09-02T21:30:00.000Z');
  const clock = () => ++now;
  const service = new AccessControlService(store, { clock: () => new Date(now) });
  let provisioner;
  try {
    service.ensureLocalOrganization({
      organization: { id: 'local-dsp', name: 'Reference DSP' },
      site: { id: 'reference-site', code: 'REF1' },
      timezone: 'America/Los_Angeles',
    });
    const referenceBefore = JSON.stringify(store.installationControl('local-dsp'));
    store.transaction(() => {
      store.insertUser({
        id: 'usr_platform_fixture', email: 'platform@example.invalid', firstName: 'Platform', lastName: 'Fixture',
        passwordHash: 'fixture-hash-not-a-secret', platformRole: 'owner', timestamp: clock(),
      });
      for (const suffix of ['alpha', 'bravo']) {
        const organizationId = `org_activation_${suffix}`;
        store.createOrganization({
          id: organizationId, name: `Activation ${suffix}`, abbreviation: suffix.toUpperCase(),
          timezone: suffix === 'alpha' ? 'America/Chicago' : 'America/New_York', status: 'setup_required',
          createdBy: 'usr_platform_fixture', timestamp: clock(),
        });
        store.insertStation(organizationId, suffix === 'alpha' ? 'TST1' : 'TST2', true, clock());
        store.createInstallation(organizationId, `runtime_activation_${suffix}`, 'pending', clock());
        const roles = service.ensureSystemRoles(organizationId, 'usr_platform_fixture', clock());
        const userId = `usr_activation_${suffix}`;
        store.insertUser({
          id: userId, email: `${suffix}@example.invalid`, firstName: suffix, lastName: 'Fixture',
          passwordHash: 'fixture-hash-not-a-secret', platformRole: null, timestamp: clock(),
        });
        store.createMembership({
          id: `mem_activation_${suffix}`, organizationId, userId, roleId: roles.owner.id,
          createdBy: 'usr_platform_fixture', timestamp: clock(),
        });
      }
    });
    let nextJob = 0;
    provisioner = createDurableInstallationProvisioner({
      stateRoot,
      installationsRoot,
      clock,
      idFactory: () => `job_activation_provision_${++nextJob}`,
      liveAuthorityResolver: createAccessControlLiveAuthorityResolver({ store }),
    });
    const reconciler = createInstallationProvisioningReconciler({ store, provisioner, clock });
    for (const suffix of ['alpha', 'bravo']) {
      createAccessInstallationProvisioningAuthority({
        store,
        organizationId: `org_activation_${suffix}`,
        authorityScope: 'platform_installation',
        actorUserId: 'usr_platform_fixture',
        clock,
        requestFactory: () => `prq_activation_${suffix}`,
      }).request({
        operation: 'provision', idempotencyKey: `activation:provision:${suffix}`, expectedRevision: 1,
      });
    }
    assert.deepEqual(reconciler.runPending('worker_activation_provision', 20), {
      processed: 2, completed: 2, failed: 0, pending: 0,
    });

    const successfulAuthority = createAccessInstallationActivationAuthority({
      store,
      organizationId: 'org_activation_alpha',
      authorityScope: 'platform_activation',
      idempotencyKey: 'activation:artifact:alpha',
      workerId: 'worker_activation_alpha',
      clock,
      jobFactory: () => 'job_activation_alpha',
    });
    const successful = await runManagedPaycomActivation({
      authority: successfulAuthority,
      runtime: artifactRuntime(
        path.join(installationsRoot, 'runtime_activation_alpha'),
        new Date(now).toISOString(),
      ),
    });
    assert.equal(successful.status, 'ready');
    const alphaPublication = fs.readFileSync(
      path.join(installationsRoot, 'runtime_activation_alpha', 'data', 'providers', 'paycom', 'first-publication.json'),
      'utf8',
    );

    const failedAuthority = createAccessInstallationActivationAuthority({
      store,
      organizationId: 'org_activation_bravo',
      authorityScope: 'platform_activation',
      idempotencyKey: 'activation:artifact:bravo',
      workerId: 'worker_activation_bravo',
      clock,
      jobFactory: () => 'job_activation_bravo',
    });
    const failed = await runManagedPaycomActivation({
      authority: failedAuthority,
      runtime: artifactRuntime(
        path.join(installationsRoot, 'runtime_activation_bravo'),
        new Date(now).toISOString(),
        { failPublication: true },
      ),
    });
    assert.equal(failed.status, 'first_publication_failed');
    assert.equal(store.installationControl('org_activation_alpha').status, 'ready');
    assert.equal(store.installationControl('org_activation_bravo').status, 'failed');
    assert.equal(fs.existsSync(
      path.join(installationsRoot, 'runtime_activation_bravo', 'data', 'providers', 'paycom', 'first-publication.json'),
    ), false);
    assert.equal(fs.readFileSync(
      path.join(installationsRoot, 'runtime_activation_alpha', 'data', 'providers', 'paycom', 'first-publication.json'),
      'utf8',
    ), alphaPublication);
    assert.equal(JSON.stringify(store.installationControl('local-dsp')), referenceBefore);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'verified',
      runtimes: 2,
      successfulActivations: 1,
      failedActivations: 1,
      atomicPublication: true,
      failureIsolation: true,
      referenceInstallationPreserved: true,
    })}\n`);
  } finally {
    try { provisioner?.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stdout.write('{"ok":false,"status":"activation_fixture_failed"}\n');
  process.exitCode = 1;
});
