'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');

function fixture(installationOperatorEnabled = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-access-control-'));
  fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: path.join(root, 'access-control'), database: path.join(root, 'access-control', 'access-control.sqlite3') };
  const time = { value: Date.parse('2026-09-02T12:00:00.000Z') };
  const store = new AccessStore(paths);
  const service = new AccessControlService(store, {
    clock: () => new Date(time.value), installationOperatorEnabled,
  });
  service.ensureLocalOrganization({
    organization: { id: 'local-dsp', name: 'EXMP' },
    site: { id: 'local-site', code: 'TST1' },
    timezone: 'America/Los_Angeles',
  });
  return { root, paths, time, store, service, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function platformOwner(service) {
  const bootstrap = service.createPlatformBootstrap({ email: 'fixture-owner@example.test', organizationId: 'local-dsp' });
  return service.acceptNewUser({
    token: bootstrap.token,
    firstName: 'Fixture Owner',
    lastName: 'Owner',
    password: 'correct horse battery staple',
    confirmPassword: 'correct horse battery staple',
  });
}

test('bootstrap creates a hashed-credential platform owner with an isolated local-DSP membership', async () => {
  const context = fixture();
  try {
    assert.deepEqual(context.service.bootstrapStatus(), { initialized: false, invitationPending: false });
    const revokedBootstrap = context.service.createPlatformBootstrap({ email: 'Fixture-owner@Example.test', organizationId: 'local-dsp' });
    assert.equal(context.service.revokePlatformBootstrap().status, 'revoked');
    assert.equal(context.service.revokePlatformBootstrap(), null);
    assert.throws(() => context.service.inspectInvitation(revokedBootstrap.token), /invitation_invalid/);
    assert.deepEqual(context.service.bootstrapStatus(), { initialized: false, invitationPending: false });
    const bootstrap = context.service.createPlatformBootstrap({ email: 'Fixture-owner@Example.test', organizationId: 'local-dsp' });
    const inspectedInvitation = context.service.inspectInvitation(bootstrap.token);
    assert.equal(inspectedInvitation.organization.name, 'EXMP');
    assert.equal(Object.hasOwn(inspectedInvitation, 'id'), false);
    assert.equal(Object.hasOwn(inspectedInvitation.organization, 'id'), false);
    assert.equal(Object.hasOwn(inspectedInvitation.role, 'id'), false);
    const accepted = await context.service.acceptNewUser({
      token: bootstrap.token,
      firstName: 'Fixture Owner',
      lastName: 'Owner',
      password: 'correct horse battery staple',
      confirmPassword: 'correct horse battery staple',
    });
    assert.equal(accepted.session.user.email, 'fixture-owner@example.test');
    assert.equal(accepted.session.user.platformRole, 'owner');
    assert.throws(() => context.service.requestInstallationProvisioning(accepted.session, 'local-dsp', {
      idempotencyKey: 'disabled:provision:local', expectedRevision: 1,
    }), /installation_operator_disabled/);
    assert.ok(accepted.session.platformPermissions.includes('platform.installations.read'));
    assert.ok(accepted.session.platformPermissions.includes('platform.installations.manage'));
    assert.equal(accepted.session.memberships[0].organizationId, 'local-dsp');
    assert.equal(accepted.session.memberships[0].roleKey, 'owner');
    assert.ok(accepted.session.memberships[0].permissions.includes('workforce.read'));
    assert.throws(() => context.service.inspectInvitation(bootstrap.token), /invitation_invalid/);

    const signedIn = await context.service.signIn({ email: 'fixture-owner@example.test', password: 'correct horse battery staple' });
    assert.equal(signedIn.session.user.id, accepted.session.user.id);
    assert.notEqual(signedIn.token, accepted.token);
    await assert.rejects(context.service.signIn({ email: 'fixture-owner@example.test', password: null }), /invalid_credentials/);
    await assert.rejects(context.service.signIn({ email: 'missing@example.test', password: null }), /invalid_credentials/);
    await assert.rejects(context.service.signIn({ email: null, password: null }), /invalid_credentials/);
    const changed = await context.service.changePassword(signedIn.session, {
      currentPassword: 'correct horse battery staple',
      newPassword: 'replacement secure passphrase',
      confirmPassword: 'replacement secure passphrase',
    });
    assert.equal(context.service.session(signedIn.token), null);
    await assert.rejects(context.service.signIn({ email: 'fixture-owner@example.test', password: 'correct horse battery staple' }), /invalid_credentials/);
    assert.equal((await context.service.signIn({ email: 'fixture-owner@example.test', password: 'replacement secure passphrase' })).session.user.id, changed.session.user.id);
    context.store.close();
    const bytes = fs.readFileSync(context.paths.database);
    assert.equal(bytes.includes(Buffer.from('correct horse battery staple')), false);
    assert.equal(bytes.includes(Buffer.from('replacement secure passphrase')), false);
    assert.equal(bytes.includes(Buffer.from(bootstrap.token)), false);
    assert.equal(fs.statSync(context.paths.database).mode & 0o777, 0o600);
    assert.equal(fs.statSync(context.paths.databaseRoot).mode & 0o777, 0o700);
  } finally {
    try { context.store.close(); } catch {}
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('organization invitations create tenant-scoped owners and prevent horizontal access', async () => {
  const context = fixture();
  try {
    const platform = await platformOwner(context.service);
    const created = context.service.createOrganization(platform.session, {
      idempotencyKey: 'test:organization:create:second',
      name: 'Second Delivery LLC', abbreviation: 'SECOND', stationCode: 'DWA1',
      timezone: 'America/Los_Angeles', ownerEmail: 'owner@second.test',
    });
    assert.equal(created.organization.status, 'pending_owner');
    assert.equal(created.organization.installation.status, 'pending');
    const second = await context.service.acceptNewUser({
      token: created.token, firstName: 'Second', lastName: 'Owner',
      password: 'a second secure passphrase', confirmPassword: 'a second secure passphrase',
    });
    const secondOrg = second.session.activeOrganizationId;
    assert.notEqual(secondOrg, 'local-dsp');
    assert.equal(second.session.platformPermissions.includes('platform.installations.manage'), false);
    assert.equal(context.store.organization(secondOrg).status, 'setup_required');
    assert.throws(() => context.service.requestInstallationProvisioning(second.session, secondOrg, {
      idempotencyKey: 'tenant:provision:forbidden', expectedRevision: 1,
    }), /platform_forbidden/);
    assert.throws(() => context.service.requirePermission(second.session, 'local-dsp', 'workforce.read'), /organization_forbidden/);
    assert.throws(() => context.service.requirePermission(platform.session, secondOrg, 'workforce.read'), /organization_forbidden/);
    assert.equal(context.service.setOrganizationSuspended(platform.session, secondOrg, { suspended: true }).status, 'suspended');
    assert.throws(() => context.service.requirePermission(second.session, secondOrg, 'workforce.read'), /organization_forbidden/);
    assert.equal(context.service.session(second.token), null);
    await assert.rejects(context.service.signIn({ email: 'owner@second.test', password: 'a second secure passphrase' }), /account_disabled/);
    assert.ok(context.service.session(platform.token));
    assert.equal(context.service.setOrganizationSuspended(platform.session, secondOrg, { suspended: false }).status, 'setup_required');
    assert.equal(context.service.session(second.token), null);
    assert.ok((await context.service.signIn({ email: 'owner@second.test', password: 'a second secure passphrase' })).session);
    assert.equal(context.service.requirePermission(second.session, secondOrg, 'workforce.read').membership.roleKey, 'owner');
    const viewer = context.store.roleByKey(secondOrg, 'driver');
    const platformInvitation = context.service.createMemberInvitation(second.session, secondOrg, {
      email: platform.session.user.email, roleId: viewer.id,
    });
    assert.throws(() => context.service.acceptExistingUser(platform.session, platformInvitation.token), /user_already_belongs_to_dsp/);
    assert.throws(() => context.service.createOrganization(second.session, {
      idempotencyKey: 'test:organization:create:unauthorized',
      name: 'Unauthorized DSP', abbreviation: null, stationCode: 'DWA2', timezone: 'UTC', ownerEmail: 'bad@example.test',
    }), /platform_forbidden/);
  } finally { context.close(); }
});

test('only platform authority can create a durable managed installation provisioning request', async () => {
  const context = fixture(true);
  try {
    const platform = await platformOwner(context.service);
    const created = context.service.createOrganization(platform.session, {
      idempotencyKey: 'test:organization:create:provisioned',
      name: 'Provisioned Delivery LLC', abbreviation: 'PROV', stationCode: 'DWA3',
      timezone: 'America/Denver', ownerEmail: 'owner@provisioned.test',
    });
    const request = context.service.requestInstallationProvisioning(
      platform.session,
      created.organization.id,
      { idempotencyKey: 'platform:provision:request', expectedRevision: 1 },
    );
    assert.equal(request.status, 'pending');
    assert.equal(request.jobId, null);
    assert.equal(context.store.installationControl(created.organization.id).status, 'provisioning');
    const replay = context.service.requestInstallationProvisioning(
      platform.session,
      created.organization.id,
      { idempotencyKey: 'platform:provision:request', expectedRevision: 1 },
    );
    assert.equal(replay.id, request.id);
    assert.equal(replay.replayed, true);
  } finally { context.close(); }
});

test('opaque platform controls are session-bound, idempotent, and expose only setup-safe state', async () => {
  const context = fixture(true);
  try {
    const platform = await platformOwner(context.service);
    const input = {
      idempotencyKey: 'test:organization:create:console',
      name: 'Console Delivery LLC', abbreviation: 'CONSOLE', stationCode: 'DWA5',
      timezone: 'America/Los_Angeles', ownerEmail: 'owner@console.test',
    };
    const created = context.service.createOrganization(platform.session, input);
    assert.equal(created.replayed, false);
    assert.equal(typeof created.token, 'string');
    const replayedCreate = context.service.createOrganization(platform.session, input);
    assert.equal(replayedCreate.replayed, true);
    assert.equal(replayedCreate.token, null);
    assert.equal(replayedCreate.organization.id, created.organization.id);
    assert.equal(context.store.organizations().filter(item => item.name === input.name).length, 1);
    assert.throws(() => context.service.createOrganization(platform.session, {
      ...input, name: 'Changed Delivery LLC',
    }), /idempotency_conflict/);

    const rows = context.service.platformOrganizations(platform.session);
    const row = rows.find(item => item.name === input.name);
    assert.match(row.controlRef, /^[A-Za-z0-9_-]{43}$/);
    assert.match(row.continuityRef, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(context.service.platformOrganizations(platform.session)
      .find(item => item.name === input.name).continuityRef, row.continuityRef);
    assert.deepEqual(row.installation.availableActions, ['provision', 'decommission']);
    assert.equal(row.availableActions.includes('suspend'), false);
    const forbiddenKeys = new Set(['id', 'organizationId', 'runtimeKey', 'jobId', 'manifestRevision', 'path', 'socket']);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbiddenKeys.has(key), false, `forbidden platform key: ${key}`);
        visit(child);
      }
    };
    visit(row);

    const anotherSession = await context.service.signIn({
      email: 'fixture-owner@example.test', password: 'correct horse battery staple',
    });
    assert.throws(() => context.service.requestPlatformInstallationProvisioning(anotherSession.session, {
      controlRef: row.controlRef,
      idempotencyKey: 'test:platform:provision:cross-session',
      expectedRevision: row.installation.revision,
    }), /platform_control_invalid/);

    const revoked = context.service.revokePlatformOwnerInvitation(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:owner-invitation:revoke',
    });
    assert.deepEqual(revoked, { status: 'revoked', replayed: false });
    assert.deepEqual(context.service.revokePlatformOwnerInvitation(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:owner-invitation:revoke',
    }), { status: 'revoked', replayed: true });
    const replacement = context.service.createPlatformOwnerInvitation(platform.session, {
      controlRef: row.controlRef,
      idempotencyKey: 'test:owner-invitation:create',
      ownerEmail: 'replacement@console.test',
    });
    assert.equal(typeof replacement.token, 'string');
    assert.equal(context.service.createPlatformOwnerInvitation(platform.session, {
      controlRef: row.controlRef,
      idempotencyKey: 'test:owner-invitation:create',
      ownerEmail: 'replacement@console.test',
    }).token, null);

    assert.deepEqual(context.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:organization:status:suspend', suspended: true,
    }), { status: 'suspended', replayed: false });
    const suspendedRow = context.service.platformOrganizations(platform.session)
      .find(organization => organization.name === input.name);
    assert.equal(suspendedRow.availableActions.includes('resume'), false);
    assert.deepEqual(suspendedRow.installation.availableActions, ['decommission']);
    assert.deepEqual(context.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:organization:status:suspend', suspended: true,
    }), { status: 'suspended', replayed: true });
    assert.throws(() => context.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:organization:status:suspend', suspended: false,
    }), /idempotency_conflict/);
    context.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:organization:status:resume', suspended: false,
    });
    assert.deepEqual(context.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'test:organization:status:suspend', suspended: true,
    }), { status: 'suspended', replayed: true });

    const provisioned = context.service.requestPlatformInstallationProvisioning(platform.session, {
      controlRef: row.controlRef,
      idempotencyKey: 'test:platform:provision:console',
      expectedRevision: row.installation.revision,
    });
    assert.deepEqual(provisioned, {
      action: 'provision', status: 'accepted', installationState: 'provisioning',
      installationRevision: 2, replayed: false,
    });
    assert.equal(context.service.requestPlatformInstallationProvisioning(platform.session, {
      controlRef: row.controlRef,
      idempotencyKey: 'test:platform:provision:console',
      expectedRevision: row.installation.revision,
    }).status, 'replayed');

    const owner = await context.service.acceptNewUser({
      token: replacement.token,
      firstName: 'Console', lastName: 'Owner',
      password: 'console owner secure passphrase', confirmPassword: 'console owner secure passphrase',
    });
    const setup = context.service.organizationSetup(owner.session);
    assert.equal(setup.installationState, 'provisioning');
    assert.equal(setup.setupState, 'waiting_for_platform');
    assert.equal(setup.operationalAccess, 'unavailable');
    assert.equal(Object.hasOwn(setup, 'organizationId'), false);
    assert.equal(Object.hasOwn(setup, 'runtimeKey'), false);

    const firstRequest = context.store.latestProvisioningRequest(created.organization.id);
    const failedProvisionJob = {
      id: 'job_console_provision_failure', operation: 'provision', status: 'queued',
      installationState: 'provisioning', revision: firstRequest.installation_revision,
    };
    context.store.transaction(() => {
      context.store.acknowledgeProvisioningRequest(firstRequest.id, failedProvisionJob, context.time.value);
      context.store.finishProvisioningRequest(firstRequest.id, {
        ...failedProvisionJob,
        status: 'failed', installationState: 'failed', revision: firstRequest.installation_revision + 1,
        failure: { code: 'runtime_health_failed' },
      }, context.time.value);
    });
    const failedControl = context.store.installationControl(created.organization.id);
    const retryInput = {
      controlRef: row.controlRef,
      idempotencyKey: 'test:platform:retry:console',
      expectedRevision: failedControl.revision,
    };
    assert.equal(context.service.requestPlatformInstallationRetry(platform.session, retryInput).status, 'accepted');
    assert.equal(context.service.requestPlatformInstallationRetry(platform.session, retryInput).status, 'replayed');

    const retryRequest = context.store.latestProvisioningRequest(created.organization.id);
    const failedRetryJob = {
      id: 'job_console_retry_failure', operation: 'retry', status: 'queued',
      installationState: 'provisioning', revision: retryRequest.installation_revision,
    };
    context.store.transaction(() => {
      context.store.acknowledgeProvisioningRequest(retryRequest.id, failedRetryJob, context.time.value);
      context.store.finishProvisioningRequest(retryRequest.id, {
        ...failedRetryJob,
        status: 'failed', installationState: 'failed', revision: retryRequest.installation_revision + 1,
        failure: { code: 'first_publication_failed' },
      }, context.time.value);
    });
    const nonInfrastructureFailure = context.service.platformOrganizations(platform.session)
      .find(organization => organization.name === input.name);
    assert.equal(nonInfrastructureFailure.installation.failure.category, 'activation');
    assert.equal(nonInfrastructureFailure.installation.availableActions.includes('retry_provision'), false);
    assert.throws(() => context.service.requestPlatformInstallationRetry(platform.session, {
      controlRef: nonInfrastructureFailure.controlRef,
      idempotencyKey: 'test:platform:retry:non-infrastructure',
      expectedRevision: nonInfrastructureFailure.installation.revision,
    }), /installation_operation_not_allowed/);
    assert.throws(() => context.store.transaction(() => context.store.createProvisioningRequest({
      id: 'prq_non_infrastructure_retry',
      organizationId: created.organization.id,
      authorityScope: 'platform_installation',
      operation: {
        operation: 'retry',
        idempotencyKey: 'test:authority:retry:non-infrastructure',
        expectedRevision: nonInfrastructureFailure.installation.revision,
      },
      timestamp: context.time.value,
    })), /installation_operation_not_allowed/);

    context.time.value += 16 * 60 * 1000;
    assert.throws(() => context.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef,
      idempotencyKey: 'test:organization:status:expired-control',
      suspended: true,
    }), /platform_control_invalid/);
    context.store.close();
    for (const file of [context.paths.database, `${context.paths.database}-wal`].filter(fs.existsSync)) {
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.includes(Buffer.from(row.controlRef)), false);
      assert.equal(bytes.includes(Buffer.from(row.continuityRef)), false);
    }
  } finally { context.close(); }
});

test('owner acceptance advances a provisioned installation from owner wait to provider setup atomically', async () => {
  const context = fixture();
  try {
    const platform = await platformOwner(context.service);
    const created = context.service.createOrganization(platform.session, {
      idempotencyKey: 'test:organization:create:owner-wait',
      name: 'Owner Wait Delivery LLC', abbreviation: 'WAIT', stationCode: 'DWA4',
      timezone: 'America/Chicago', ownerEmail: 'owner@waiting.test',
    });
    const installation = context.store.installationControl(created.organization.id);
    context.store.transaction(() => context.store.updateInstallationControl({
      organizationId: created.organization.id,
      expectedStatus: 'pending',
      expectedRevision: installation.revision,
      status: 'waiting_for_owner',
      revision: installation.revision + 1,
      currentJobId: null,
      timestamp: context.time.value,
    }));
    await context.service.acceptNewUser({
      token: created.token,
      firstName: 'Waiting',
      lastName: 'Owner',
      password: 'waiting owner secure passphrase',
      confirmPassword: 'waiting owner secure passphrase',
    });
    assert.equal(context.store.organization(created.organization.id).status, 'setup_required');
    assert.deepEqual(context.store.installationControl(created.organization.id), {
      organizationId: created.organization.id,
      runtimeKey: `runtime_${created.organization.id.slice(4)}`,
      status: 'waiting_for_provider_auth',
      revision: 3,
      manifestRevision: 1,
      releaseId: 'dispatch_current_1',
      currentJobId: null,
    });
  } finally { context.close(); }
});

test('all four fixed roles have equal DSP permissions and can invite and assign every role', async t => {
  const context = fixture();
  t.after(() => context.close());
  const { service, store } = context;
  const owner = await platformOwner(service);
  const roles = store.roles('local-dsp');
  assert.deepEqual(roles.map(role => role.name), ['Owner', 'Manager', 'Dispatcher', 'Driver']);
  const actors = [];
  for (const role of roles) {
    assert.equal(role.system, true);
    assert.deepEqual(role.permissions, roles[0].permissions);
    assert.equal(role.permissions.includes('roles.manage'), false);
    const invite = service.createMemberInvitation(owner.session, 'local-dsp', { email: `${role.key}@example.test`, roleId: role.id });
    const member = await service.acceptNewUser({ token: invite.token, firstName: 'Team', lastName: role.name,
      password: 'another secure passphrase', confirmPassword: 'another secure passphrase' });
    assert.equal(member.session.memberships[0].roleName, role.name);
    assert.deepEqual(member.session.platformPermissions, []);
    actors.push(member);
  }
  const ownerMembership = store.membership(owner.session.user.id, 'local-dsp');
  const target = store.membership(actors[0].session.user.id, 'local-dsp');
  for (const actor of actors) {
    assert.equal(service.organizationAdministration(actor.session, 'local-dsp').roles.length, 4);
    for (const permission of roles[0].permissions) service.requirePermission(actor.session, 'local-dsp', permission);
    assert.throws(() => service.createRole(actor.session, 'local-dsp', { name: 'Custom', permissions: [] }), /fixed_roles_only/);
    for (const role of roles) {
      assert.throws(() => service.updateRole(actor.session, 'local-dsp', role.id, {}), /fixed_roles_only/);
      assert.throws(() => service.deleteRole(actor.session, 'local-dsp', role.id), /fixed_roles_only/);
      const invite = service.createMemberInvitation(actor.session, 'local-dsp', {
        email: `${actor.session.user.id}-${role.key}@example.test`, roleId: role.id,
      });
      service.revokeMemberInvitation(actor.session, 'local-dsp', invite.invitation.id);
      if (actor !== actors[0]) service.updateMemberRole(actor.session, 'local-dsp', target.id, role.id);
    }
  }
  // Drivers can assign ownership and manage Owners, but nobody can leave the
  // DSP without an Owner or change/remove their own membership.
  const driver = actors[3];
  service.updateMemberRole(driver.session, 'local-dsp', target.id, roles[0].id);
  service.removeMember(driver.session, 'local-dsp', target.id);
  assert.throws(() => service.updateMemberRole(driver.session, 'local-dsp', ownerMembership.id, roles[3].id), /last_owner_protected/);
  assert.throws(() => service.removeMember(driver.session, 'local-dsp', ownerMembership.id), /last_owner_protected/);
  const driverMembership = store.membership(driver.session.user.id, 'local-dsp');
  assert.throws(() => service.updateMemberRole(driver.session, 'local-dsp', driverMembership.id, roles[0].id), /self_role_change_forbidden/);
  assert.throws(() => service.removeMember(driver.session, 'local-dsp', driverMembership.id), /self_removal_forbidden/);
  const custom = store.createRole({ id: 'legacy_custom', organizationId: 'local-dsp', key: null, name: 'Legacy', description: '',
    system: false, permissions: [], createdBy: owner.session.user.id, timestamp: service.now() });
  assert.throws(() => service.createMemberInvitation(driver.session, 'local-dsp', { email: 'legacy@example.test', roleId: custom.id }), /role_not_assignable/);
  assert.throws(() => service.updateMemberRole(driver.session, 'local-dsp', ownerMembership.id, custom.id), /role_not_assignable/);
});

test('platform removal revokes invitation and tenant administration immediately, preserves peers, and replays once', async t => {
  const context = fixture(true);
  t.after(() => context.close());
  const { service, store } = context;
  const platform = await platformOwner(service);
  const create = (suffix, ownerEmail) => service.createOrganization(platform.session, {
    idempotencyKey: `removal:create:${suffix}`, name: `Removal ${suffix}`, abbreviation: suffix.toUpperCase(),
    stationCode: 'DWA1', timezone: 'America/Chicago', ownerEmail,
  });
  const alpha = create('alpha', 'alpha@example.test');
  const beta = create('beta', 'beta@example.test');
  const owner = await service.acceptNewUser({ token: alpha.token, firstName: 'Alpha', lastName: 'Owner',
    password: 'a secure fixture password', confirmPassword: 'a secure fixture password' });
  const memberInvite = service.createMemberInvitation(owner.session, alpha.organization.id, {
    email: 'member@example.test', roleId: store.roleByKey(alpha.organization.id, 'driver').id,
  });
  const row = service.platformOrganizations(platform.session).find(row => row.name === alpha.organization.name);
  const input = { controlRef: row.controlRef, idempotencyKey: 'removal:alpha:request',
    expectedRevision: row.installation.revision };
  await assert.rejects(service.requestPlatformRemoval(owner.session, input, 'decommission'), /platform_forbidden/);
  await assert.rejects(service.requestPlatformRemoval(platform.session, { ...input, confirmation: 'wrong' }, 'decommission'), /invalid_input/);
  const removal = await service.requestPlatformRemoval(platform.session, input, 'decommission');
  assert.equal(removal.installationState, 'decommissioning');
  assert.equal((await service.requestPlatformRemoval(platform.session, input, 'decommission')).replayed, true);
  assert.equal(service.session(owner.token), null);
  await assert.rejects(service.signIn({ email: 'alpha@example.test', password: 'a secure fixture password' }), /account_disabled/);
  assert.equal(store.invitationById(memberInvite.invitation.id).status, 'pending');
  assert.equal(store.lifecycleExecutionCandidates(context.time.value, 20).length, 1);
  assert.throws(() => service.organizationMembership(owner.session), /organization_forbidden/);
  assert.throws(() => service.organizationSetup(owner.session), /organization_forbidden/);
  assert.throws(() => service.inspectInvitation(memberInvite.token), /invitation_invalid/);
  assert.equal(service.inspectInvitation(beta.token).organization.name, beta.organization.name);
  assert.equal(store.organization(beta.organization.id).status, 'pending_owner');
  assert.throws(() => service.setOrganizationSuspended(platform.session, alpha.organization.id, { suspended: false }), /installation_operation_not_allowed/);
  const removed = service.platformOrganizations(platform.session).find(row => row.name === alpha.organization.name);
  assert.deepEqual(removed.availableActions, []);
  assert.deepEqual(removed.installation.operation, { kind: 'decommission', status: 'queued' });
  assert.deepEqual(removed.installation.availableActions, []);
});

// An access revocation must not disconnect the agent before its stop job exists.
for (const route of ['direct', 'platform']) test(`${route} suspension preserves agent authority until its stop job completes`, async () => {
  const c = fixture(true);
  try {
    const platform = await platformOwner(c.service);
    c.service = new AccessControlService(c.store, { clock: () => new Date(c.time.value), installationOperatorEnabled: true, installationBackend: 'native_service_v1' });
    const created = c.service.createOrganization(platform.session, { ownerEmail: 'suspension@example.test', idempotencyKey: 'regression:create:native' });
    const organizationId = created.organization.id;
    c.store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(organizationId);
    c.store.updateOrganizationStatus(organizationId, 'active', c.time.value);
    const installation = c.store.installationControl(organizationId);
    c.store.recordRuntimeAgentAuthority({ organizationId: organizationId, runtimeKey: installation.runtimeKey,
      tokenHash: 'a'.repeat(64), timestamp: c.time.value });
    assert.ok(c.store.activeRuntimeAgentAuthority(installation.runtimeKey));
    if (route === 'direct') c.service.setOrganizationSuspended(platform.session, organizationId, { suspended: true });
    else {
      const row = c.service.platformOrganizations(platform.session).find(r => r.ownerEmail === 'suspension@example.test');
      c.service.setPlatformOrganizationSuspended(platform.session, {
        controlRef: row.controlRef, idempotencyKey: 'regression:suspend:authority', suspended: true,
      });
    }
    assert.equal(c.store.organization(organizationId).status, 'suspended');
    assert.equal(c.store.activeLifecycleJob(organizationId).operation, 'suspend');
    assert.ok(c.store.activeRuntimeAgentAuthority(installation.runtimeKey));
    assert.equal(c.store.activeRuntimeAgentAuthorityCount(), 1);
  } finally { c.close(); }
});

// Model a successfully activated DSP after its suspension worker has stopped it.
test('both dashboard resume routes reactivate an installed suspended DSP', async () => {
  const c = fixture(true);
  try {
    const platform = await platformOwner(c.service);
    c.store.db.prepare("UPDATE installations SET status='suspended' WHERE organization_id='local-dsp'").run();
    c.store.latestReadyEvidence = () => ({ previouslyVerified: true });
    c.store.updateOrganizationStatus('local-dsp', 'suspended', c.time.value);
    assert.equal(c.service.setOrganizationSuspended(platform.session, 'local-dsp', { suspended: false }).status, 'active');
    c.store.updateOrganizationStatus('local-dsp', 'suspended', c.time.value);
    const row = c.service.platformOrganizations(platform.session).find(r => r.name === 'EXMP');
    assert.equal(c.service.setPlatformOrganizationSuspended(platform.session, {
      controlRef: row.controlRef, idempotencyKey: 'regression:resume:activated', suspended: false,
    }).status, 'active');
    c.store.latestReadyEvidence = () => null;
    c.store.updateOrganizationStatus('local-dsp', 'suspended', c.time.value);
    assert.equal(c.service.setOrganizationSuspended(platform.session, 'local-dsp', { suspended: false }).status, 'setup_required');
  } finally { c.close(); }
});


test('DSP listing and opaque controls remain read-only under a lifecycle writer lock', async t => {
  const context = fixture(); t.after(() => context.close());
  const owner = await platformOwner(context.service);
  const created = context.service.createOrganization(owner.session, {
    idempotencyKey: 'listing:expired:invitation', name: 'Expired Invitation', abbreviation: 'EXP',
    stationCode: 'DWA5', timezone: 'America/Los_Angeles', ownerEmail: 'expired@example.test',
  });
  context.store.db.prepare('UPDATE invitations SET expires_at=? WHERE organization_id=?')
    .run(context.time.value, created.organization.id);
  const { DatabaseSync } = require('node:sqlite');
  const writer = new DatabaseSync(context.paths.database); t.after(() => writer.close());
  writer.exec('BEGIN IMMEDIATE');
  try {
    const changes = context.store.db.prepare('SELECT total_changes() AS count').get().count;
    const start = performance.now();
    const rows = context.service.platformOrganizations(owner.session);
    for (const row of rows) {
      assert.equal(context.service.resolvePlatformControl(owner.session, row.controlRef).organization.name, row.name);
    }
    assert.ok(performance.now() - start < 250, 'DSP polling must not stall Runtime Agent requests');
    assert.equal(context.store.db.prepare('SELECT total_changes() AS count').get().count, changes);
    const expired = rows.find(row => row.name === 'Expired Invitation');
    assert.equal(expired.ownerStatus, 'missing');
    assert.equal(expired.ownerInvitation, null);
    assert.ok(expired.availableActions.includes('issue_owner_invitation'));
  } finally { writer.exec('ROLLBACK'); }
});

test('stateless platform controls reject tampering and support existing stored references', async t => {
  const context = fixture(); t.after(() => context.close());
  const owner = await platformOwner(context.service);
  const reference = context.service.issuePlatformControlRef(owner.session, 'local-dsp');
  const invalid = value => assert.throws(() => context.service.resolvePlatformControl(owner.session, value), /platform_control_invalid/);
  for (const offset of [0, 7, 8, 31]) {
    const bytes = Buffer.from(reference, 'base64url'); bytes[offset] ^= 1;
    invalid(bytes.toString('base64url'));
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  invalid(reference.slice(0, -1) + alphabet[alphabet.indexOf(reference.at(-1)) + 1]);
  invalid(context.service.issuePlatformControlRef(owner.session, 'missing-organization'));
  const crypto = require('node:crypto');
  const legacy = crypto.randomBytes(32).toString('base64url');
  context.store.createPlatformTargetRef({ referenceHash: crypto.createHash('sha256').update(legacy).digest('hex'),
    sessionHash: owner.session.tokenHash, userId: owner.session.user.id, organizationId: 'local-dsp',
    purpose: 'organization_control', expiresAt: context.time.value + 1000, timestamp: context.time.value });
  assert.equal(context.service.resolvePlatformControl(owner.session, legacy).organizationId, 'local-dsp');
  const another = context.service.createSession(owner.session.user.id);
  for (const value of [reference, legacy]) {
    assert.throws(() => context.service.resolvePlatformControl(another.session, value), /platform_control_invalid/);
  }
  context.time.value += 1000;
  invalid(legacy);
  context.time.value += 15 * 60 * 1000;
  invalid(reference);
  context.time.value = Date.parse(owner.session.expiresAt) - 1000;
  const lastReference = context.service.issuePlatformControlRef(owner.session, 'local-dsp');
  assert.equal(Number(Buffer.from(lastReference, 'base64url').readBigUInt64BE()), Date.parse(owner.session.expiresAt));
  context.time.value += 1000;
  invalid(lastReference);
});

test('session activity never waits for a DSP writer lock and still enforces revocation and expiry', async t => {
  const context = fixture(); t.after(() => context.close());
  const owner = await platformOwner(context.service);
  const { DatabaseSync } = require('node:sqlite');
  const writer = new DatabaseSync(context.paths.database); t.after(() => writer.close());
  const hash = owner.session.tokenHash;
  const before = context.store.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash=?').get(hash).last_seen_at;
  context.time.value += 1000;
  writer.exec('BEGIN IMMEDIATE');
  try {
    const start = performance.now();
    assert.equal(context.service.requireSession(owner.token).user.id, owner.session.user.id);
    assert.ok(performance.now() - start < 250, 'session reads must not stall the Runtime Agent connection');
    assert.equal(context.store.db.prepare('PRAGMA busy_timeout').get().timeout, 3000);
    assert.equal(context.store.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash=?').get(hash).last_seen_at, before);
  } finally { writer.exec('ROLLBACK'); }
  context.service.requireSession(owner.token);
  assert.equal(context.store.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash=?').get(hash).last_seen_at, context.time.value);
  writer.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(context.time.value, hash);
  assert.equal(context.service.session(owner.token), null);
  writer.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(context.time.value + 10000, hash);
  writer.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(owner.session.user.id);
  assert.equal(context.service.session(owner.token), null);
});

test('schema 13 migrates every DSP and preserves memberships, sessions, and invitation links on reopen', async t => {
  const context = fixture();
  t.after(() => context.close());
  const { store, service } = context;
  const owner = await platformOwner(service);
  store.createOrganization({ id: 'second-dsp', name: 'Second DSP', abbreviation: null, timezone: 'UTC', status: 'suspended', createdBy: owner.session.user.id, timestamp: service.now() });
  service.ensureSystemRoles('second-dsp', owner.session.user.id, service.now());
  const canonical = ['owner', 'manager'].map(key => store.roleByKey('local-dsp', key));
  const dispatcher = store.roleByKey('local-dsp', 'dispatcher');
  const memberInvite = service.createMemberInvitation(owner.session, 'local-dsp', { email: 'legacy-member@example.test', roleId: dispatcher.id });
  const member = await service.acceptNewUser({ token: memberInvite.token, firstName: 'Legacy', lastName: 'Member',
    password: 'migration secure password', confirmPassword: 'migration secure password' });
  const membershipId = store.membership(member.session.user.id, 'local-dsp').id;
  const invitations = [];
  for (const org of store.organizations()) {
    // Recreate the previous catalog, including a custom role named Dispatcher.
    store.db.prepare("UPDATE roles SET key='administrator',name='Administrator' WHERE organization_id=? AND key='dispatcher'").run(org.id);
    store.db.prepare("UPDATE roles SET key='viewer',name='Viewer' WHERE organization_id=? AND key='driver'").run(org.id);
    for (const [suffix, name] of [['matching', 'Dispatcher'], ['custom', 'Route lead']]) {
      store.createRole({ id: `${org.id}_${suffix}`, organizationId: org.id, key: null, name, description: 'Legacy custom role',
        system: false, permissions: ['dashboard.view'], createdBy: owner.session.user.id, timestamp: service.now() });
    }
    for (const role of store.roles(org.id)) {
      const rawToken = require('../src/service').opaqueToken();
      const invitation = store.createInvitation({ id: `legacy_${role.id}`, kind: 'organization_member', organizationId: org.id,
        roleId: role.id, email: `${role.id}@example.test`, tokenHash: require('../src/service').tokenHash(rawToken),
        expiresAt: service.now() + 3600000, createdBy: owner.session.user.id, timestamp: service.now() });
      if (role.name === 'Route lead') store.revokeInvitation(invitation.id);
      invitations.push({ ...store.invitationById(invitation.id), rawToken, expectedRole: role.key === 'administrator' ? 'Manager'
        : role.key === 'viewer' ? 'Driver' : role.system ? role.name : 'Dispatcher' });
    }
  }
  store.db.exec("DELETE FROM role_permissions WHERE permission <> 'dashboard.view'; PRAGMA user_version=12;");
  store.close();
  const migrated = new AccessStore(context.paths);
  t.after(() => migrated.close());
  const access = new AccessControlService(migrated, { clock: () => new Date(context.time.value) });
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  for (const org of migrated.organizations()) {
    const roles = migrated.roles(org.id);
    assert.deepEqual(roles.map(role => role.name), ['Owner', 'Manager', 'Dispatcher', 'Driver']);
    for (const role of roles) assert.deepEqual(role.permissions, roles[0].permissions);
  }
  for (const role of canonical) assert.equal(migrated.roleByKey('local-dsp', role.key).id, role.id);
  assert.equal(migrated.membership(member.session.user.id, 'local-dsp').id, membershipId);
  assert.equal(access.session(member.token).memberships[0].roleName, 'Manager');
  assert.equal(migrated.invitationById(memberInvite.invitation.id).status, 'accepted');
  for (const original of invitations) {
    const current = migrated.invitationById(original.id);
    assert.equal(current.roleName, original.expectedRole);
    for (const field of ['status', 'expiresAt', 'email', 'createdAt', 'acceptedAt']) assert.equal(current[field], original[field]);
    assert.equal(migrated.invitationByHash(require('../src/service').tokenHash(original.rawToken)).id, original.id);
    if (original.organizationId === 'local-dsp' && original.status === 'pending') {
      assert.equal(access.inspectInvitation(original.rawToken).role.name, original.expectedRole);
    }
  }
  const selected = invitations.find(invite => invite.organizationId === 'local-dsp' && invite.expectedRole === 'Driver');
  const accepted = await access.acceptNewUser({ token: selected.rawToken, firstName: 'Migrated', lastName: 'Driver',
    password: 'migration secure password', confirmPassword: 'migration secure password' });
  assert.equal(accepted.session.memberships[0].roleName, 'Driver');
  const snapshot = migrated.db.prepare('SELECT * FROM roles ORDER BY id').all();
  migrated.close();
  const reopened = new AccessStore(context.paths);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM roles ORDER BY id').all(), snapshot);
  reopened.close();
});

test('failed fixed-role migration rolls back role references and schema version', t => {
  const context = fixture();
  t.after(() => context.close());
  const { store } = context;
  store.db.exec("UPDATE roles SET key='viewer',name='Viewer' WHERE key='driver'; PRAGMA user_version=12;");
  const original = store.db.prepare('SELECT * FROM roles ORDER BY id').all();
  store.db.exec("CREATE TRIGGER fail_fixed_roles BEFORE DELETE ON roles BEGIN SELECT RAISE(ABORT, 'migration_fixture_failure'); END;");
  store.close();
  assert.throws(() => new AccessStore(context.paths), /access_storage_unavailable/);
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(context.paths.database);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 12);
  assert.deepEqual(raw.prepare('SELECT * FROM roles ORDER BY id').all(), original);
  raw.exec('DROP TRIGGER fail_fixed_roles');
  raw.close();
  const retried = new AccessStore(context.paths);
  assert.equal(retried.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
  assert.deepEqual(retried.roles('local-dsp').map(role => role.name), ['Owner', 'Manager', 'Dispatcher', 'Driver']);
  retried.close();
});
