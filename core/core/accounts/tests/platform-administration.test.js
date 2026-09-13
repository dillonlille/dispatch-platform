'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');
const { completeRolloutBackups } = require('../../installations/tests/helpers/rollout-backups');
const { createPlatformUpdates } = require('../src/platform-updates');
const { applyOrganizationProfiles } = require('../src/organization-profile');
const { managedInstallationContext } = require('../src/installation-authority');
const { createOwnerPaycomSetup } = require('../src/owner-paycom-setup');
async function fixture(t, backend = 'oci_container_v1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-platform-admin-')); fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/access-control.sqlite3') };
  const store = new AccessStore(paths);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: backend });
  const invitation = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const platform = await access.acceptNewUser({ token: invitation.token, firstName: 'Platform', lastName: 'Owner',
    password: 'test platform password', confirmPassword: 'test platform password' });
  const create = (n, emailOnly = true) => access.createOrganization(platform.session, { ownerEmail: `owner${n}@example.test`,
    idempotencyKey: `admin:creation:${n}`, ...(emailOnly ? {} : { name: `DSP ${n}`, stationCode: 'TST1', timezone: 'UTC' }) });
  const platformReleases = { dispatch_update_2: { version: '0.0.2', publishedAt: '2026-09-05T00:00:00.000Z',
    changelog: [{ kind: 'fixed', title: 'Example fix', description: '' }], core: {} } };
  const updates = (finishCore = true) => {
    const coordinator = createPlatformUpdates({ store, releases: { dispatch_update_2: {} }, platformReleases, enabled: true });
    // Fleet tests simulate the external updater's terminal receipt; dedicated tests below exercise that worker.
    return { ...coordinator, command(session, input) {
      const result = coordinator.command(session, input);
      if (input.action === 'start') completeRolloutBackups(store);
      return result;
    }, tick() {
      if (finishCore) store.db.prepare("UPDATE platform_rollout_core SET status='succeeded' WHERE status='queued'").run();
      return coordinator.tick();
    } };
  };
  return { store, access, platform, create, updates, paths, platformReleases };
}
test('email creation atomically queues exactly one runtime and invitation; replay cannot duplicate either', async t => {
  const f = await fixture(t);
  const first = f.create(100), replay = f.create(100);
  assert.equal(replay.organization.id, first.organization.id);
  assert.equal(replay.token, null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM installation_provisioning_requests').get().n, 1);
  assert.equal(f.store.installationControl(first.organization.id).status, 'provisioning');
  const view = f.access.platformOrganizations(f.platform.session)[0];
  assert.equal(view.detailsStatus, 'required'); assert.equal(view.ownerEmail, 'owner100@example.test');
  assert.equal(view.name, 'New DSP');
  const original = f.store.createProvisioningRequest;
  f.store.createProvisioningRequest = () => { throw new Error('queue unavailable'); };
  assert.throws(() => f.create(101), /queue unavailable/);
  f.store.createProvisioningRequest = original;
  assert.equal(f.store.organizations().length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM invitations WHERE kind='organization_owner'").get().n, 1);
});
test('owner details wait for provisioning, preserve runtime identity and gate provider setup', async t => {
  const f = await fixture(t); const created = f.create(200);
  const owner = await f.access.acceptNewUser({ token: created.token, firstName: 'DSP', lastName: 'Owner',
    password: 'test owner password', confirmPassword: 'test owner password' });
  const before = managedInstallationContext(f.store, created.organization.id);
  const details = { name: 'Northstar Delivery', abbreviation: 'NS', stationCode: 'DWA1', timezone: 'America/Chicago' };
  assert.throws(() => f.access.organizationProfile(f.platform.session, details), /organization_required|organization_forbidden/);
  assert.throws(() => f.access.organizationProfile(owner.session, { ...details, organizationId: 'org_other' }), /invalid_input/);
  assert.throws(() => f.access.organizationProfile(owner.session, { ...details, timezone: 'Invalid/Zone' }), /invalid_input/);
  assert.equal(f.access.organizationProfile(owner.session, details).status, 'submitted');
  assert.equal(f.store.organization(created.organization.id).name, 'New DSP');
  require('./plugin-fixture').enableFixturePlugin(f.store, created.organization.id);
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.access, invoke: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => setup.status(owner.session), /organization_details_required/);
  // The infrastructure worker has finished; applying details requires no container recreation.
  f.store.db.prepare("UPDATE installations SET status='waiting_for_provider_auth' WHERE organization_id=?").run(created.organization.id);
  assert.equal(applyOrganizationProfiles(f.store), 1);
  const after = managedInstallationContext(f.store, created.organization.id);
  assert.deepEqual(after.manifest.runtime, before.manifest.runtime);
  assert.equal(after.organization.id, before.organization.id);
  assert.equal(after.manifest.organization.stationCode, 'DWA1');
  assert.equal(after.manifest.organization.timezone, 'America/Chicago');
  assert.equal(f.access.organizationProfile(owner.session).status, 'complete');
  assert.equal((await setup.status(owner.session)).canSubmit, true);
  assert.throws(() => f.access.organizationProfile(owner.session, details), /organization_details_complete/);
  assert.equal(applyOrganizationProfiles(f.store), 0);
});
function ready(f, created) {
  f.store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(created.organization.id);
  f.store.updateOrganizationStatus(created.organization.id, 'active', Date.now());
}
function finishWorkerJob(f, id, status) {
  // Simulate the private lifecycle worker's terminal receipt; its real stage/evidence
  // verification is covered by the provisioner lifecycle suite.
  f.store.db.prepare('UPDATE installation_lifecycle_jobs SET status=?,failure_code=?,finished_at=?,result_json=? WHERE id=?').run(status, status === 'failed' ? 'upgrade_failed' : null, Date.now(), status === 'succeeded' ? '{}' : null, id);
  const job = f.store.lifecycleJob(id);
  f.store.db.prepare("UPDATE installations SET status='ready',release_id=? WHERE organization_id=?")
    .run(status === 'succeeded' ? 'dispatch_update_2' : 'dispatch_current_1', job.organization_id);
}
test('rollout persists across restart, updates one DSP at a time, pauses and retries without skips', async t => {
  const f = await fixture(t); const one = f.create(301, false), two = f.create(302, false);
  ready(f, one); ready(f, two);
  let coordinator = f.updates();
  const command = { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:test:all-dsps' };
  coordinator.command(f.platform.session, command); coordinator.command(f.platform.session, command);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 1);
  assert.throws(() => coordinator.command(f.platform.session, { ...command, idempotencyKey: 'rollout:test:duplicate' }), /rollout_in_progress/);
  coordinator.tick(); coordinator.tick();
  let jobs = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade'").all();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].organization_id, one.organization.id);
  assert.equal(coordinator.view().rollout.members[1].status, 'queued');
  // Crash after job persistence but before the link is saved: reconnect by request key.
  f.store.db.prepare('UPDATE platform_rollout_members SET job_id=NULL').run();
  coordinator = f.updates(); coordinator.tick();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 1);
  finishWorkerJob(f, jobs[0].id, 'failed'); coordinator.tick();
  assert.equal(coordinator.view().rollout.status, 'paused');
  coordinator.tick(); assert.equal(coordinator.view().rollout.members[1].status, 'queued');
  coordinator.command(f.platform.session, { action: 'resume' }); coordinator.tick(); coordinator.tick();
  jobs = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade' ORDER BY rowid").all();
  assert.equal(jobs.length, 2); assert.equal(jobs[1].organization_id, one.organization.id);
  finishWorkerJob(f, jobs[1].id, 'succeeded'); coordinator.tick();
  coordinator.command(f.platform.session, { action: 'pause' }); coordinator.tick();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 2);
  coordinator.command(f.platform.session, { action: 'resume' }); coordinator.tick(); coordinator.tick();
  jobs = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade' ORDER BY rowid").all();
  assert.equal(jobs[2].organization_id, two.organization.id);
  finishWorkerJob(f, jobs[2].id, 'succeeded'); coordinator.tick(); coordinator.tick();
  assert.equal(coordinator.view().rollout.status, 'completed');
  assert.equal(coordinator.view().rollout.updated, 2);
});
test('unready DSPs block completion and new DSPs inherit the fleet target and join the rollout', async t => {
  const f = await fixture(t); f.create(400, false);
  const c = f.updates(); c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:test:unready' });
  c.tick(); assert.equal(c.view().rollout.status, 'paused'); assert.equal(c.view().rollout.updated, 0);
  const fresh = f.create(401);
  assert.equal(f.store.installationControl(fresh.organization.id).releaseId, 'dispatch_update_2');
  c.tick(); assert.equal(c.view().rollout.total, 2);
  assert.equal(c.view().rollout.status, 'paused');
});
test('nested transactions retain atomic rollback for rollout job creation', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.transaction(() => { f.create(501); throw new Error('outer failure'); }), /outer failure/);
  assert.equal(f.store.organizations().length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM installation_provisioning_requests').get().n, 0);
  assert.equal(f.create(501).organization.name, 'New DSP');
});
test('schema 8 upgrades preserve existing organizations and enable email profiles and durable rollouts', async t => {
  const f = await fixture(t); const created = f.create(600, false);
  f.store.db.exec('DROP TABLE platform_rollout_core; DROP TABLE platform_rollout_members; DROP TABLE platform_rollouts; DROP TABLE organization_profiles; PRAGMA user_version=8;');
  const migrated = new AccessStore(f.paths);
  try {
    assert.equal(migrated.organization(created.organization.id).name, 'DSP 600');
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
    assert.equal(migrated.db.prepare('SELECT count(*) n FROM organization_profiles').get().n, 0);
  } finally { migrated.close(); }
});

test('exhausted worker leases pause and resume the existing job instead of duplicating an upgrade', async t => {
  const f = await fixture(t); const created = f.create(701, false); ready(f, created);
  const c = f.updates(); c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:test:exhausted' });
  c.tick(); c.tick();
  const job = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade'").get();
  f.store.db.prepare("UPDATE installation_lifecycle_jobs SET status='running',attempt=max_attempts,lease_expires_at=?,worker_id='worker_old' WHERE id=?").run(Date.now() - 1, job.id);
  c.tick(); assert.equal(c.view().rollout.status, 'paused');
  c.command(f.platform.session, { action: 'resume' });
  assert.equal(f.store.lifecycleJob(job.id).status, 'queued');
  assert.equal(f.store.lifecycleJob(job.id).attempt, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 1);
});
test('a removed DSP remains visible in rollout history and no longer blocks the current fleet', async t => {
  const f = await fixture(t); const created = f.create(801, false);
  const c = f.updates(); c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:test:removed' });
  c.tick(); assert.equal(c.view().rollout.status, 'paused');
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id=?").run(created.organization.id);
  c.tick(); c.command(f.platform.session, { action: 'resume' }); c.tick();
  assert.equal(c.view().rollout.status, 'completed'); assert.equal(c.view().rollout.total, 0);
  assert.equal(c.view().rollout.members[0].status, 'removed');
});

test('an existing owner cannot accept a second DSP membership', async t => {
  const f = await fixture(t); const first = f.create(901);
  const owner = await f.access.acceptNewUser({ token: first.token, firstName: 'Multi', lastName: 'Owner',
    password: 'multiple dsp password', confirmPassword: 'multiple dsp password' });
  const second = f.access.createOrganization(f.platform.session, { ownerEmail: 'owner901@example.test', idempotencyKey: 'admin:second:dsp:901' });
  assert.throws(() => f.access.acceptExistingUser(owner.session, second.token), /user_already_belongs_to_dsp/);
  assert.equal(f.store.membershipsForUser(owner.session.user.id).length, 1);
});

test('Core must update and pass verification before the first DSP job can start', async t => {
  const f = await fixture(t); const dsp = f.create(901, false); ready(f, dsp);
  const c = f.updates(false);
  c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:core:first' });
  c.tick(); c.tick();
  assert.equal(c.view().rollout.phase, 'core');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 0);
  const stages = [];
  const worker = require('../../installations/src/platform-core-update').createPlatformCoreUpdater({ store: f.store,
    platformReleases: f.platformReleases, execute: async action => {
      stages.push(action); c.tick();
      assert.equal(c.view().rollout.phase, action === 'apply' ? 'core' : 'verify_core');
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 0);
    } });
  assert.equal((await worker.run()).status, 'core_verified');
  assert.deepEqual(stages, ['apply', 'verify']);
  c.tick(); c.tick();
  assert.equal(c.view().rollout.phase, 'dsps');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 1);
});

test('Core failure pauses an empty-fleet rollout; resume retries and completes after verification', async t => {
  const f = await fixture(t); const c = f.updates(false);
  c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:core:empty' });
  let broken = true;
  const worker = require('../../installations/src/platform-core-update').createPlatformCoreUpdater({ store: f.store,
    platformReleases: f.platformReleases, execute: async action => { if (action === 'verify' && broken) throw new Error('private diagnostic'); } });
  assert.equal((await worker.run()).status, 'core_update_failed');
  c.tick(); assert.equal(c.view().rollout.status, 'paused');
  assert.doesNotMatch(JSON.stringify(c.view()), /private diagnostic|artifactPath/);
  assert.equal((await worker.run()).status, 'idle');
  broken = false; c.command(f.platform.session, { action: 'resume' });
  assert.equal((await worker.run()).status, 'core_verified');
  c.tick(); assert.equal(c.view().rollout.status, 'completed');
  assert.equal(c.view().releases.length, 0);
});

test('Core progress survives interruptions and a pause finishes only an already started stage', async t => {
  const f = await fixture(t); const c = f.updates(false);
  c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:core:restart' });
  c.command(f.platform.session, { action: 'pause' });
  const calls = [];
  const worker = () => require('../../installations/src/platform-core-update').createPlatformCoreUpdater({ store: f.store,
    platformReleases: f.platformReleases, execute: async action => calls.push(action) });
  assert.equal((await worker().run()).status, 'idle');
  f.store.db.prepare("UPDATE platform_rollout_core SET status='verifying',attempt=1").run();
  assert.equal((await worker().run()).status, 'core_verified');
  assert.deepEqual(calls, ['verify']);
  c.tick(); assert.equal(c.view().rollout.status, 'paused');
  c.command(f.platform.session, { action: 'resume' }); c.tick();
  assert.equal(c.view().rollout.status, 'completed');
});

test('runtime-only releases cannot start a rollout and queued bundles cannot change underneath the worker', async t => {
  const f = await fixture(t);
  const incomplete = createPlatformUpdates({ store: f.store, releases: { dispatch_update_2: {} }, enabled: true });
  assert.equal(incomplete.view().releases.length, 0);
  assert.throws(() => incomplete.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:core:incomplete' }), /update_unavailable/);
  const c = f.updates(false); c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:core:pinned' });
  const worker = require('../../installations/src/platform-core-update').createPlatformCoreUpdater({ store: f.store,
    platformReleases: { dispatch_update_2: { ...f.platformReleases.dispatch_update_2, version: '0.0.3' } },
    execute: async () => assert.fail('Changed bundle must not execute') });
  assert.equal((await worker.run()).status, 'core_update_failed');
  assert.equal(c.view().rollout.status, 'paused');
});

test('schema 9 rollouts require Core verification after migration without changing accounts', async t => {
  const f = await fixture(t); const c = f.updates(false);
  c.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:core:migrate' });
  const before = f.store.db.prepare('SELECT * FROM users').all();
  f.store.db.exec('DROP TABLE platform_rollout_core; PRAGMA user_version=9;');
  const migrated = new AccessStore(f.paths);
  try {
    const updates = createPlatformUpdates({ store: migrated, releases: { dispatch_update_2: {} }, platformReleases: f.platformReleases, enabled: true });
    updates.tick(); assert.equal(updates.view().rollout.phase, 'core');
    assert.equal(updates.view().rollout.core.status, 'queued');
    assert.deepEqual(migrated.db.prepare('SELECT * FROM users').all(), before);
    assert.equal(migrated.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 0);
  } finally { migrated.close(); }
});


test('newly prepared release catalogs become available without restarting Core', async t => {
  const f = await fixture(t);
  let catalogs = { releases: {}, platformReleases: {} };
  const updates = createPlatformUpdates({ store: f.store, enabled: true, loadCatalogs: () => catalogs });
  assert.deepEqual(updates.view().releases, []);
  catalogs = { releases: { dispatch_update_2: {} }, platformReleases: f.platformReleases };
  assert.equal(updates.view().releases[0].version, '0.0.2');
  updates.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'reload:catalog:1' });
  assert.equal(updates.view().rollout.core.status, 'queued');
});


test('changing a release after Core verification cannot advance DSPs onto a different bundle', async t => {
  const f = await fixture(t); ready(f, f.create(920));
  const updates = f.updates(false);
  updates.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'pin:after:core:001' });
  completeRolloutBackups(f.store);
  f.store.db.prepare("UPDATE platform_rollout_core SET status='succeeded'").run();
  f.platformReleases.dispatch_update_2.version = '0.0.3';
  updates.tick();
  assert.equal(updates.view().rollout.status, 'paused');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n, 0);
  assert.equal(updates.view().rollout.core.status, 'failed');
});

test('permanent deletion requires removal and the acting administrator password', async t => {
  const f = await fixture(t), target = f.create(1201, false), peer = f.create(1202, false);
  ready(f, target); ready(f, peer);
  const row = f.access.platformOrganizations(f.platform.session).find(r => r.name === target.organization.name);
  assert.ok(!row.installation.availableActions.includes('destroy'));
  const command = { controlRef: row.controlRef, password: 'test platform password',
    expectedRevision: row.installation.revision, idempotencyKey: 'deletion:removed:1201' };
  await assert.rejects(f.access.requestPlatformRemoval(f.platform.session, command, 'destroy'), /installation_operation_not_allowed/);
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id=?").run(target.organization.id);
  await assert.rejects(f.access.requestPlatformRemoval(f.platform.session, { ...command, password: 'wrong' }, 'destroy'), /current_password_invalid/);
  await assert.rejects(f.access.requestPlatformRemoval(f.platform.session, { ...command, password: undefined }, 'destroy'), /current_password_invalid/);
  await f.access.requestPlatformRemoval(f.platform.session, command, 'destroy');
  assert.equal((await f.access.requestPlatformRemoval(f.platform.session, command, 'destroy')).replayed, true);
  assert.ok(!f.store.db.prepare('SELECT stage_receipts_json FROM installation_lifecycle_jobs WHERE organization_id=?').get(target.organization.id).stage_receipts_json.includes(command.password));
  assert.equal(f.store.organization(target.organization.id).status, 'suspended');
  assert.throws(() => f.access.inspectInvitation(target.token), /invitation_invalid/);
  assert.equal(f.store.organization(peer.organization.id).status, 'active');
  const job = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE organization_id=?").get(target.organization.id);
  assert.equal(job.operation, 'destroy');assert.equal(job.backup_id, null);
  assert.equal(f.access.platformOrganizations(f.platform.session).length, 2);
  f.store.db.prepare("UPDATE installation_lifecycle_jobs SET status='failed',failure_code='destruction_failed',finished_at=1 WHERE id=?").run(job.id);
  const failed = f.access.platformOrganizations(f.platform.session).find(r => r.name === row.name);
  assert.equal(failed.installation.operation.status, 'failed');
  f.store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',failure_code=NULL,result_json='{}' WHERE id=?").run(job.id);
  assert.deepEqual(f.access.platformOrganizations(f.platform.session).map(r => r.name), [peer.organization.name]);
});

test('completed destruction clears only its DSP access and backup metadata while retaining shared users', async t => {
  const f = await fixture(t), target=f.create(1301,false), peer=f.create(1302,false);
  const owner=await f.access.acceptNewUser({token:target.token,firstName:'DSP',lastName:'Owner',password:'synthetic owner password',confirmPassword:'synthetic owner password'});
  const backup='backup_'+'c'.repeat(32), other='backup_'+'d'.repeat(32);
  const insert=f.store.db.prepare("INSERT INTO platform_backup_records(id,organization_id,kind,metadata_json,created_at) VALUES (?,?,'dsp',?,1)");
  insert.run(backup,target.organization.id,JSON.stringify({private:'target DSP backup details'}));
  insert.run(other,peer.organization.id,JSON.stringify({private:'peer details'}));
  f.store.transaction(()=>{ f.store.destroyInstallationBackups(target.organization.id,2000); f.store.destroyOrganizationAccess(target.organization.id); });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memberships WHERE organization_id=?').get(target.organization.id).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM roles WHERE organization_id=?').get(target.organization.id).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM organization_profiles WHERE organization_id=?').get(target.organization.id).n,0);
  assert.ok(f.store.db.prepare('SELECT id FROM users WHERE id=?').get(owner.session.user.id));
  assert.equal(f.store.db.prepare('SELECT metadata_json FROM platform_backup_records WHERE id=?').get(backup).metadata_json,'{}');
  assert.equal(f.store.db.prepare('SELECT deleted_at FROM platform_backup_records WHERE id=?').get(other).deleted_at,null);
  assert.ok(f.store.db.prepare('SELECT count(*) n FROM roles WHERE organization_id=?').get(peer.organization.id).n>0);
});


test('schema 10 migration preserves legacy DSPs and dependent records while enabling native creation', async t => {
  const f = await fixture(t);
  const created = f.create(898, false);
  const tables = ['organizations', 'users', 'sessions', 'memberships', 'invitations',
    'installations', 'installation_provisioning_requests', 'runtime_agent_authorities'];
  const before = Object.fromEntries(tables.map(table => [table, f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  // Restore the previous backend CHECK in this disposable database's catalog.
  // Closing the connection makes SQLite parse the actual version-10 schema on
  // reopen, instead of merely lowering user_version on an already-native table.
  f.store.db.exec('PRAGMA writable_schema=ON');
  f.store.db.prepare("UPDATE sqlite_schema SET sql=replace(sql, ?, '') WHERE type='table' AND name='installations'")
    .run(",'native_service_v1'");
  f.store.db.prepare("UPDATE sqlite_schema SET sql=replace(sql, ?, '') WHERE type='table' AND name='installations'")
    .run(",'directory_service_v1'");
  f.store.db.exec('PRAGMA writable_schema=OFF; PRAGMA user_version=10');
  f.store.close();
  const migrated = new AccessStore(f.paths);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
    for (const table of tables) assert.deepEqual(migrated.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], table);
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(migrated.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.throws(() => migrated.db.prepare("UPDATE installations SET backend='native_service_v1' WHERE organization_id=?")
      .run(created.organization.id), /installation_backend_immutable/);
    const access = new AccessControlService(migrated, { installationOperatorEnabled: true, installationBackend: 'native_service_v1' });
    const native = access.createOrganization(f.platform.session, { ownerEmail: 'native-after-migration@example.test',
      idempotencyKey: 'migration:native:create' });
    assert.equal(migrated.installationBackend(native.organization.id), 'native_service_v1');
    assert.equal(migrated.installationBackend(created.organization.id), 'oci_container_v1');
  } finally { migrated.close(); }
});

test('native rollout refuses legacy DSPs before queuing Core and allows decommissioned history', async t => {
  const f = await fixture(t);
  const created = f.create(899, false);
  const coordinator = createPlatformUpdates({ store: f.store,
    releases: { dispatch_update_2: { backend: 'native_service_v1' } },
    platformReleases: f.platformReleases, enabled: true });
  const start = { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:native:legacy' };
  assert.throws(() => coordinator.command(f.platform.session, start), /native_migration_required/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollout_core').get().n, 0);
  f.store.db.prepare("UPDATE installations SET status='decommissioning' WHERE organization_id=?").run(created.organization.id);
  assert.throws(() => coordinator.command(f.platform.session, start), /native_migration_required/);
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id=?").run(created.organization.id);
  coordinator.command(f.platform.session, start);
  coordinator.command(f.platform.session, start);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT status FROM platform_rollout_core').get().status, 'queued');
});

test('native rollout updates suspended and setup DSPs, assigns pending DSPs, and waits for storage cleanup', async t => {
  const f = await fixture(t, 'native_service_v1');
  const states = ['pending', 'suspended', 'waiting_for_owner', 'waiting_for_provider_auth'];
  const created = states.map((_, i) => f.create(900 + i, false));
  f.store.db.prepare("UPDATE installation_provisioning_requests SET status='completed',finished_at=?").run(Date.now());
  for (let i = 0; i < states.length; i++) {
    f.store.db.prepare('UPDATE installations SET status=? WHERE organization_id=?').run(states[i], created[i].organization.id);
    if (states[i] === 'suspended') f.store.updateOrganizationStatus(created[i].organization.id, 'suspended', Date.now());
  }
  let cleaned = false;
  const options = { store: f.store, releases: { dispatch_update_2: { backend: 'native_service_v1' } },
    platformReleases: f.platformReleases, enabled: true, cleanupReady: () => cleaned };
  let coordinator = createPlatformUpdates(options);
  coordinator.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:native:offline' });
  completeRolloutBackups(f.store);
  f.store.db.prepare("UPDATE platform_rollout_core SET status='succeeded'").run();
  const visited = new Set();
  for (let step = 0; step < 30; step++) {
    coordinator = createPlatformUpdates(options); coordinator.tick();
    const job = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE status='queued'").get();
    if (!job) continue;
    visited.add(job.starting_state);
    const authority = require('../src/installation-lifecycle').createAccessInstallationLifecycleAuthority({
      store: f.store, organizationId: job.organization_id, authorityScope: 'platform_rollout',
      actorUserId: f.platform.session.user.id, releaseCatalog: ['dispatch_update_2'],
    });
    if (job.starting_state !== 'suspended') assert.ok(authority.claim(job.id, 'worker_native_fixture'));
    if (job.starting_state === 'suspended') {
      // Readiness is needed for a real suspended DSP; this fixture only tests fleet scheduling.
      assert.equal(JSON.parse(job.stages_json).includes('start_release'), false);
    } else assert.equal(JSON.parse(job.stages_json).includes('verify_release_publication'), false);
    f.store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',lease_expires_at=NULL,finished_at=?,result_json='{}' WHERE id=?").run(Date.now(), job.id);
    f.store.db.prepare('UPDATE installations SET status=?,release_id=? WHERE organization_id=?').run(job.starting_state, 'dispatch_update_2', job.organization_id);
  }
  assert.deepEqual([...visited].sort(), states.filter(s => s !== 'pending').sort());
  assert.equal(coordinator.view().rollout.updated, 4);
  assert.equal(coordinator.view().rollout.status, 'running');
  cleaned = true; coordinator.tick();
  assert.equal(coordinator.view().rollout.status, 'completed');
  for (let i = 0; i < states.length; i++) assert.equal(f.store.installationControl(created[i].organization.id).status, states[i]);
});

test('removed owner accounts stay signed out until restoration completes and never regain old sessions', async t => {
  const f = await fixture(t, 'native_service_v1'), target = f.create(1401, false);
  const owner = await f.access.acceptNewUser({ token: target.token, firstName: 'Retained', lastName: 'Owner',
    password: 'retained owner password', confirmPassword: 'retained owner password' });
  f.store.db.prepare("UPDATE installations SET status='waiting_for_provider_auth' WHERE organization_id=?").run(target.organization.id);
  const row = f.access.platformOrganizations(f.platform.session)[0];
  await f.access.requestPlatformRemoval(f.platform.session, { controlRef: row.controlRef,
    expectedRevision: row.installation.revision, idempotencyKey: 'accounts:remove:1401' }, 'decommission');
  assert.equal(f.access.session(owner.token), null);
  const { createAccessInstallationLifecycleAuthority } = require('../src/installation-lifecycle');
  const authority = createAccessInstallationLifecycleAuthority({ store: f.store, organizationId: target.organization.id, authorityScope: 'platform_removal' });
  const job = f.store.activeLifecycleJob(target.organization.id), claim = authority.claim(job.id, 'worker_accounts_remove');
  for (const [stage, status] of [['inspect_schedule', 'verified'], ['quiesce_schedule', 'stopped'], ['stop_runtime', 'stopped'], ['disable_runtime', 'disabled'], ['verify_retained', 'retained']])
    authority.checkpoint(claim.claim, stage, { status, ...(stage === 'inspect_schedule' ? { syncWasRunning: false } : {}) });
  authority.succeed(claim.claim);
  let removed = f.access.platformOrganizations(f.platform.session)[0];
  assert.deepEqual(removed.installation.availableActions, ['destroy', 'restore_dsp']);
  await f.access.requestPlatformRemoval(f.platform.session, { controlRef: removed.controlRef,
    expectedRevision: removed.installation.revision, idempotencyKey: 'accounts:restore:1401' }, 'resume');
  await assert.rejects(f.access.signIn({ email: 'owner1401@example.test', password: 'retained owner password' }), /account_disabled/);
  const restore = f.store.activeLifecycleJob(target.organization.id), restoreClaim = authority.claim(restore.id, 'worker_accounts_restore');
  authority.checkpoint(restoreClaim.claim, 'start_runtime', { status: 'started' });
  authority.checkpoint(restoreClaim.claim, 'verify_infrastructure', { status: 'verified' });
  authority.succeed(restoreClaim.claim);
  assert.ok((await f.access.signIn({ email: 'owner1401@example.test', password: 'retained owner password' })).session);
  assert.equal(f.access.session(owner.token), null);
  assert.equal(f.store.organization(target.organization.id).status, 'setup_required');
  assert.ok(!f.access.platformOrganizations(f.platform.session)[0].installation.availableActions.includes('destroy'));
});

test('release selection preserves installed notes and archived history without permitting historical rollouts', async t => {
  const f = await fixture(t);
  const old = { ...f.platformReleases.dispatch_update_2, version: '0.0.1', publishedAt: '2026-09-01T00:00:00.000Z' };
  const rich = { groups: [{ id: 'updates', title: 'Updates', icon: 'info' }], changelog: [], afterUpdating: [] };
  const coordinator = createPlatformUpdates({store:f.store,enabled:true,releases:{dispatch_update_2:{}},platformReleases:f.platformReleases,
    delivery:{view:()=>null,history:()=>({dispatch_old:old}),notes:id=>id==='dispatch_old'?rich:null}});
  assert.equal(coordinator.view().displayedRelease.id,'dispatch_update_2');
  const history = coordinator.view('dispatch_old');
  assert.equal(history.displayedRelease.state,'historical');
  assert.deepEqual(history.displayedRelease.notes,rich);
  assert.equal(history.releaseHistory.length,2);
  assert.throws(()=>coordinator.view('dispatch_unknown'),/release_not_found/);
  assert.throws(()=>coordinator.command(f.platform.session,{action:'start',releaseId:'dispatch_old',idempotencyKey:'history:forbidden:1'}),/update_unavailable/);
  coordinator.command(f.platform.session,{action:'start',releaseId:'dispatch_update_2',idempotencyKey:'history:rollout:start:1'});
  assert.equal(coordinator.view().displayedRelease.state,'rolling_out');
  f.store.db.prepare("UPDATE platform_rollouts SET status='completed'").run();
  f.store.db.prepare("UPDATE platform_rollout_core SET status='succeeded'").run();
  assert.equal(coordinator.view().displayedRelease.state,'installed');
  assert.deepEqual(coordinator.view().displayedRelease.changelog,f.platformReleases.dispatch_update_2.changelog);
  assert.throws(()=>coordinator.command(f.platform.session,{action:'start',releaseId:'dispatch_update_2',idempotencyKey:'history:downgrade:1'}),/update_unavailable/);
});

test('designated test DSP collects on the candidate before fleet updates, with durable proof', async t => {
  const f = await fixture(t, 'native_service_v1');
  const ordinary = f.create(1300, false), canary = f.create(1301, false);
  ready(f, ordinary); ready(f, canary);
  let resolveCheck;
  let checks = 0;
  const options = { store: f.store, releases: { dispatch_update_2: { backend: 'native_service_v1' } },
    platformReleases: f.platformReleases, enabled: true, cleanupReady: () => true,
    canaryVerifier: () => { checks += 1; return new Promise(resolve => { resolveCheck = resolve; }); } };
  let updates = createPlatformUpdates(options);
  updates.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:canary:fixture', canaryOrganizationId: canary.organization.id });
  assert.throws(() => updates.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:canary:fixture', canaryOrganizationId: ordinary.organization.id }), /idempotency_conflict/);
  completeRolloutBackups(f.store);
  f.store.db.prepare("UPDATE platform_rollout_core SET status='succeeded'").run();
  updates.tick();
  assert.equal(f.store.db.prepare("SELECT organization_id FROM platform_rollout_members WHERE status='updating'").get().organization_id, canary.organization.id);
  // Model the lifecycle worker's candidate verification; the collection gate
  // must still run even though installation health and release checks passed.
  f.store.db.prepare("UPDATE installations SET release_id='dispatch_update_2' WHERE organization_id=?").run(canary.organization.id);
  f.store.db.prepare("UPDATE platform_rollout_members SET status='updated' WHERE organization_id=?").run(canary.organization.id);
  updates.tick(); await new Promise(resolve => setImmediate(resolve));
  updates.tick();
  assert.equal(checks, 1);
  assert.equal(f.store.db.prepare("SELECT status FROM platform_rollout_members WHERE organization_id=?").get(ordinary.organization.id).status, 'queued');
  resolveCheck(true); await new Promise(resolve => setImmediate(resolve));
  updates = createPlatformUpdates({ ...options, canaryVerifier: () => { throw Error('must reuse proof'); } });
  updates.tick();
  assert.equal(f.store.db.prepare("SELECT status FROM platform_rollout_members WHERE organization_id=?").get(ordinary.organization.id).status, 'updating');
});

test('test DSP collection failure pauses the fleet before any other DSP updates', async t => {
  const f = await fixture(t, 'native_service_v1');
  const canary = f.create(1302, false), ordinary = f.create(1303, false);
  ready(f, canary); ready(f, ordinary);
  const updates = createPlatformUpdates({ store: f.store, releases: { dispatch_update_2: { backend: 'native_service_v1' } },
    platformReleases: f.platformReleases, enabled: true, canaryVerifier: async () => { throw Error('synthetic_failure'); } });
  updates.command(f.platform.session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:canary:failure', canaryOrganizationId: canary.organization.id });
  completeRolloutBackups(f.store);
  f.store.db.prepare("UPDATE platform_rollout_core SET status='succeeded'").run();
  f.store.db.prepare("UPDATE installations SET release_id='dispatch_update_2' WHERE organization_id=?").run(canary.organization.id);
  f.store.db.prepare("UPDATE platform_rollout_members SET status='updated' WHERE organization_id=?").run(canary.organization.id);
  updates.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.view().rollout.status, 'paused');
  assert.equal(f.store.db.prepare("SELECT status FROM platform_rollout_members WHERE organization_id=?").get(ordinary.organization.id).status, 'queued');
  assert.doesNotMatch(JSON.stringify(updates.view()), /synthetic_failure/);
});
