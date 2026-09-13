'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { fork, spawnSync } = require('node:child_process');
const { AccessStore } = require('../../../accounts/src/store');
const { createAccessInstallationProvisioningAuthority, createAccessControlLiveAuthorityResolver,
  createInstallationProvisioningReconciler } = require('../../../accounts/src/installation-provisioning');
const { createAccessInstallationLifecycleAuthority } = require('../../../accounts/src/installation-lifecycle');
const { createDurableInstallationProvisioner } = require('../../src/jobs');
const { createProtectedOciHostClient } = require('../../src/oci-protected-client');
const { createOciContainerAdapter } = require('../../src/oci-adapter');
const { createOciRuntimeAgentCredentialPort } = require('../../src/oci-runtime-agent-credential');
const { createOciInstallationLifecycle } = require('../../src/oci-lifecycle');
const { createOciRuntimeLifecyclePort } = require('../../src/oci-runtime-lifecycle-port');
const { CoreRuntimeAgentHub, createRuntimeAgentDispatchClient, runtimeAgentControlInvoke } = require('../../../agents/src');
const { CoreRuntimeAgentControlServer } = require('../../../agents/src/control');
const { INSTALLATION_ACTIVATION_RUNS, installationActivationEvidenceDigest } = require('../../../../shared/contracts/src');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const runtimeKeys = ['runtime_lifecycle_alpha', 'runtime_lifecycle_beta'];
const credentials = createOciRuntimeAgentCredentialPort({ credentialRoot: path.join(config.controllerRoot, 'credentials') });
function manifest(index, revision = 1, releaseId = 'dispatch_current_1') {
  return { manifestVersion: 1, revision, organization: { id: `org_lifecycle_${index}`, stationCode: 'TEST', timezone: 'UTC' },
    runtime: { key: runtimeKeys[index], templateId: 'isolated_dsp_v1', releaseId } };
}
function authority(value) { return { revision: value.revision, organization: value.organization, runtime: value.runtime }; }
const client = key => createRuntimeAgentDispatchClient({ runtimeKey: key, hub: {
  invoke: async (runtimeKey, action, input) => {
    try { return await runtimeAgentControlInvoke(config.controlSocket, runtimeKey, action, input); }
    catch (error) { process.stderr.write(JSON.stringify({ controlFailure: error.code, action }) + '\n'); throw error; }
  } } });
async function hubMain() {
  const authorities = Object.fromEntries(runtimeKeys.map(runtimeKey => [runtimeKey,
    crypto.createHash('sha256').update(credentials.read(runtimeKey)).digest('hex')]));
  const hub = new CoreRuntimeAgentHub({ socketPath: config.centralSocket, authorities });
  await hub.start();
  const control = new CoreRuntimeAgentControlServer({ socketPath: config.controlSocket, hub: { invoke: async (...args) => {
    try { return await hub.invoke(...args); } catch (error) { process.stderr.write(JSON.stringify({ hubFailure: error.code, action: args[1], connected: hub.status().connected }) + '\n'); throw error; }
  } } });
  await control.start();
  process.send({ ready: true });
  process.once('SIGTERM', async () => { await control.close(); await hub.close(); process.exit(0); });
}
async function main() {
  const input = readline.createInterface({ input: process.stdin });
  const pending = [];
  input.on('line', line => pending.shift()?.(JSON.parse(line)));
  const hostFixture = value => new Promise(resolve => {
    pending.push(resolve); process.stdout.write(`${JSON.stringify(value)}\n`);
  });
  const phase = value => process.stdout.write(`${JSON.stringify({ phase: value })}\n`);
  for (const key of runtimeKeys) credentials.issue(key);
  const hub = fork(__filename, [process.argv[2], '--hub'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise((resolve, reject) => { hub.once('message', resolve); hub.once('error', reject); hub.once('exit', () => reject(new Error('hub exited'))); });
  const root = config.controllerRoot;
  const store = new AccessStore({ databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/access-control.sqlite3') });
  store.insertUser({ id: 'usr_fixture_owner', email: 'fixture@example.invalid', firstName: 'Synthetic', lastName: 'Fixture',
    passwordHash: 'fixture-not-a-password', platformRole: 'owner', timestamp: Date.now() });
  let provisioner;
  let lifecycleAuthority;
  const host = createProtectedOciHostClient({ dispatchRequest: (request, dispatch) => {
    try { return (Object.hasOwn(request.claim, 'generation') ? provisioner : lifecycleAuthority).dispatchHostRequest(request, dispatch); }
    catch (error) { phase(`failed_host_${request.operation}_${error.code || error.message}_${error.hostStep || 'none'}`); throw error; }
  } });
  const adapter = createOciContainerAdapter({ hostRegistry: host.hostRegistry, hostExecutor: host.hostExecutor,
    releaseResolver: id => config.releases[id], credentialPort: credentials });
  provisioner = createDurableInstallationProvisioner({ stateRoot: path.join(root, 'provisioner'),
    installationsRoot: path.join(root, 'unused-installations'), ociAdapter: adapter, leaseMs: 600_000,
    liveAuthorityResolver: createAccessControlLiveAuthorityResolver({ store }) });
  const reconciler = createInstallationProvisioningReconciler({ store, provisioner, runtimeAgentCredentials: credentials });
  let sequence = 0;
  const plans = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const selected = manifest(index);
      store.createOrganization({ id: selected.organization.id, name: `Synthetic ${index}`, abbreviation: `S${index}`,
        timezone: 'UTC', status: 'active', createdBy: null, timestamp: Date.now() });
      store.insertStation(selected.organization.id, 'TEST', true, Date.now());
      store.createInstallation(selected.organization.id, selected.runtime.key, 'pending', Date.now(), 'dispatch_current_1', 'oci_container_v1');
      const provisioning = createAccessInstallationProvisioningAuthority({ store, organizationId: selected.organization.id,
        authorityScope: 'fixture_authority', actorUserId: 'usr_fixture_owner' });
      const requested = provisioning.request({ operation: 'provision', idempotencyKey: `fixture:provision:${index}`, expectedRevision: 1 });
      const job = reconciler.dispatch(requested.id);
      phase(`provision_${index}`);
      const result = provisioner.runNext(`worker_fixture_${index}`);
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(reconciler.reconcile(requested.id).status, 'completed');
      assert.equal(reconciler.reconcile(requested.id).status, 'completed');
      // Synthetic first-publication data is seeded by a fixed fixture executable
      // in the test image, using the real provider publication store.
      const seeded = await hostFixture({ seed: index });
      assert.equal(seeded.ok, true, JSON.stringify(seeded));
      const c = client(selected.runtime.key);
      assert.equal((await c.workforce.day({ date: '2026-09-05', limit: 1, offset: 0 })).status, 'found');
      assert.equal((await c.sync.start('paycom-main-workforce')).status, 'started');
      const runs = INSTALLATION_ACTIVATION_RUNS.map((run, i) => ({ id: `run_fixture_${i}`, taskId: run.taskId, plan: run.plan, method: run.method }));
      const pub = (value, runId, originRunId) => ({ id: value.publicationId, runId, originRunId,
        contentSha256: value.contentSha256, batchBound: true });
      const body = { schemaVersion: 1, manifestRevision: 1, jobId: `job_activation_${index}`, runtimeKey: selected.runtime.key,
        definitionDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64), previewDigest: 'c'.repeat(64),
        batchId: `batch_fixture_${index}`, preparationRunId: 'run_periods_fixture', target: '2026-09-05', runs,
        publications: { payPeriods: { id: seeded.payPeriods.publicationId, runId: 'run_periods_fixture', originRunId: 'run_periods_fixture',
          contentSha256: seeded.payPeriods.contentSha256, batchBound: false }, roster: pub(seeded.roster, runs[0].id, 'run_fixture_roster'),
          timecards: pub(seeded.timecards, runs[1].id, 'run_fixture_timecards'), resourceLinks: pub(seeded.links, runs[3].id, 'run_fixture_links') }, capturedAt: new Date().toISOString() };
      const evidence = { ...body, evidenceDigest: installationActivationEvidenceDigest(body) };
      const ctl = store.installationControl(selected.organization.id);
      store.db.prepare("UPDATE installations SET status='ready',current_job_id=? WHERE organization_id=?").run(body.jobId, selected.organization.id);
      store.db.prepare(`INSERT INTO installation_activation_jobs(
        id,organization_id,operation,status,installation_state,installation_revision,manifest_revision,
        runtime_key,authority_scope,idempotency_key,worker_id,fence,lease_expires_at,provider,profile_id,
        provider_tested_at,evidence_json,evidence_digest,failure_code,created_at,started_at,finished_at,updated_at)
        VALUES(?,?,'resume','succeeded','ready',?,1,?,'fixture_authority',?,'worker_fixture',1,NULL,'paycom','paycom-main',?,?,?,?,?,?,?,?)`)
        .run(body.jobId, selected.organization.id, ctl.revision, selected.runtime.key, `fixture:activation:${index}`,
          Date.now(), JSON.stringify(evidence), evidence.evidenceDigest, null, Date.now(), Date.now(), Date.now(), Date.now());
    }
    const changed = await hostFixture({ seed: 0, changed: true });
    assert.equal(changed.ok, true);
    assert.equal((await client(runtimeKeys[0]).workforce.day({ date: '2026-09-19', limit: 1, offset: 0 })).status, 'found');
    const betaBefore = await hostFixture({ inspectBeta: true });
    const run = async (operation, additions = {}, failPublication = false) => {
      const organizationId = manifest(0).organization.id;
      lifecycleAuthority = createAccessInstallationLifecycleAuthority({ store, organizationId, authorityScope: 'fixture_authority',
        releaseCatalog: Object.keys(config.releases), destructionEnabled: true, leaseMs: 600_000 });
      const requested = lifecycleAuthority.request({ operation, expectedRevision: store.installationControl(organizationId).revision,
        idempotencyKey: `fixture:lifecycle:${++sequence}`, ...additions });
      phase(operation + (failPublication ? '_partial_failure' : ''));
      const lifecycle = createOciInstallationLifecycle({ authority: lifecycleAuthority, adapter, hostExecutor: host.hostExecutor,
        backupManagerFactory: (plan, claim) => host.createBackupManager(plan, claim), runtimeFactory: plan => {
          const port = createOciRuntimeLifecyclePort({ client: client(plan.runtimeKey) });
          const checkedPort = Object.fromEntries(Object.entries(port).map(([name, method]) => [name, async (...args) => {
            try { return await method(...args); } catch (error) { phase(`failed_runtime_${name}_${error.code || error.message}`); throw error; }
          }]));
          return failPublication ? { ...checkedPort, verifyPublication: async () => { throw new Error('synthetic_failure_after_start'); } } : checkedPort;
        } });
      const result = await lifecycle.run(requested.id, `worker_lifecycle_${sequence}`);
      assert.equal(result.status, failPublication ? 'failed' : 'succeeded', JSON.stringify(result));
      assert.deepEqual(await hostFixture({ inspectBeta: true }), betaBefore);
      return { result, backups: lifecycleAuthority.backups() };
    };
    const catalogFile = path.join(root, 'oci-releases.json');
    fs.writeFileSync(catalogFile, JSON.stringify({ schemaVersion: 1, releases: config.releases }), { mode: 0o600 });
    phase('backup_cli');
    const cli = spawnSync('/usr/bin/node', ['--no-warnings', path.resolve(__dirname, "../../bin/dispatch-installation-lifecycle"),
      'backup', manifest(0).organization.id], { encoding: 'utf8', timeout: 600_000,
      env: { PATH: '/usr/bin:/bin', DISPATCH_ACCESS_CONTROL_DATABASE_ROOT: path.join(root, 'access'),
        DISPATCH_INSTALLATIONS_ROOT: path.join(root, 'unused-installations'), DISPATCH_SYSTEMD_UNIT_ROOT: path.join(root, 'unused-units'),
        DISPATCH_RUNTIME_AGENT_HUB_SOCKET: config.centralSocket, DISPATCH_RUNTIME_AGENT_CONTROL_SOCKET: config.controlSocket,
        DISPATCH_OCI_RELEASE_CATALOG_FILE: catalogFile, DISPATCH_OCI_RUNTIME_AGENT_CREDENTIAL_ROOT: path.join(root, 'credentials') } });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status, 'succeeded');
    assert.deepEqual(await hostFixture({ inspectBeta: true }), betaBefore);
    const backup = { backups: createAccessInstallationLifecycleAuthority({ store, organizationId: manifest(0).organization.id,
      authorityScope: 'fixture_authority', releaseCatalog: Object.keys(config.releases) }).backups() };
    await run('suspend');
    assert.equal((await client(runtimeKeys[0]).system.status()).ok, false);
    assert.equal((await hostFixture({ mutateSentinel: true })).ok, true);
    await run('restore', { backupId: backup.backups.find(value => value.purpose === 'manual').id });
    assert.equal((await hostFixture({ verifySentinel: true })).ok, true);
    await run('resume');
    await run('upgrade', { releaseId: 'dispatch_fixture_2' });
    await run('upgrade', { releaseId: 'dispatch_fixture_3' }, true);
    assert.equal(store.installationControl(manifest(0).organization.id).releaseId, 'dispatch_fixture_2');
    assert.equal((await client(runtimeKeys[0]).sync.status('paycom-main-workforce')).data.desiredState, 'running');
    await run('decommission');
    assert.equal((await hostFixture({ retained: true })).ok, true);
    await run('destroy');
    assert.equal((await hostFixture({ destroyed: true })).ok, true);
    phase('lifecycle_verified');
  } finally {
    provisioner.close(); store.close(); hub.kill('SIGTERM');
    await new Promise(resolve => hub.once('exit', resolve)); input.close();
  }
}
(process.argv[3] === '--hub' ? hubMain() : main()).catch(error => {
  process.stderr.write(`${error.stack}\n`); process.exitCode = 1;
});
