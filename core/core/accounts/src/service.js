'use strict';

const crypto = require('node:crypto');
const {
  AccessError, exact, text, identifier, email, password, token, controlReference, idempotencyKey,
  timezone, station, abbreviation,
} = require('./validation');
const { hashPassword, verifyPassword, consumeEquivalentPasswordWork } = require('./passwords');
const { TENANT_PERMISSIONS, SYSTEM_ROLES, PLATFORM_PERMISSIONS } = require('./permissions');
const {
  installationTransition,
  installationFailure,
  platformInstallationStatus,
  platformOrganization,
  platformInstallationReceipt,
  organizationSetupStatus,
} = require('../../../shared/contracts/src');
const { createAccessInstallationProvisioningAuthority } = require('./installation-provisioning');
const { createAccessInstallationLifecycleAuthority } = require('./installation-lifecycle');
const { runtimeBackend } = require('../../runtime-deployment');

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
const PLATFORM_CONTROL_TTL_MS = 15 * 60 * 1000;

function opaqueToken() { return crypto.randomBytes(32).toString('base64url'); }
function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
function iso(timestamp) { return new Date(timestamp).toISOString(); }
function valueDigest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function platformContinuityRef(sessionHash, organizationId) {
  return crypto.createHmac('sha256', sessionHash)
    .update(`dispatch_platform_row\0${organizationId}`)
    .digest('base64url');
}
function platformControlMac(session, organizationId, expiry, purpose = 'dispatch_platform_control_v1') {
  return crypto.createHmac('sha256', session.tokenHash)
    .update(`${purpose}\0${session.user.id}\0${organizationId}\0`)
    .update(expiry).digest().subarray(0, 24);
}
function storedResult(row) {
  try {
    const value = JSON.parse(row.result_json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch { throw new AccessError('access_schema_incompatible', 500); }
}

function maskedEmail(value) {
  const [local, domain] = value.split('@');
  const shown = local.length <= 2 ? local[0] : `${local[0]}${'*'.repeat(Math.min(6, local.length - 2))}${local.at(-1)}`;
  return `${shown}@${domain}`;
}

function safeConflict(error) {
  if (error instanceof AccessError) return error;
  if (/UNIQUE constraint failed/i.test(String(error?.message || ''))) return new AccessError('conflict', 409);
  return error;
}

class AccessControlService {
  constructor(store, {
    clock = () => new Date(),
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    invitationTtlMs = DEFAULT_INVITATION_TTL_MS,
    installationOperatorEnabled = false,
    installationBackend = 'systemd_user',
  } = {}) {
    if (!store || typeof store.transaction !== 'function' || typeof clock !== 'function'
        || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 15 * 60 * 1000 || sessionTtlMs > 30 * 24 * 60 * 60 * 1000
        || !Number.isSafeInteger(invitationTtlMs) || invitationTtlMs < 15 * 60 * 1000 || invitationTtlMs > 30 * 24 * 60 * 60 * 1000
        || typeof installationOperatorEnabled !== 'boolean') {
      throw new TypeError('access_control_dependencies_required');
    }
    this.store = store;
    this.clock = clock;
    this.sessionTtlMs = sessionTtlMs;
    this.invitationTtlMs = invitationTtlMs;
    this.installationOperatorEnabled = installationOperatorEnabled;
    try { this.installationBackend = runtimeBackend(installationBackend); }
    catch { throw new TypeError('access_control_dependencies_required'); }
    if (this.installationBackend === 'local_reference') throw new TypeError('access_control_dependencies_required');
  }

  now() { return this.clock().getTime(); }

  audit({ actorUserId = null, organizationId = null, action, targetType, targetId = null, result = 'succeeded', timestamp = this.now() }) {
    this.store.createAudit({
      id: id('aud'), actorUserId, organizationId, action, targetType, targetId, result, timestamp,
    });
  }

  ensureSystemRoles(organizationId, createdBy, timestamp) {
    const roles = {};
    for (const definition of SYSTEM_ROLES) {
      let role = this.store.roleByKey(organizationId, definition.key);
      if (!role) {
        role = this.store.createRole({
          id: id('role'), organizationId, key: definition.key, name: definition.name,
          description: definition.description, system: true, permissions: definition.permissions,
          createdBy, timestamp,
        });
      }
      roles[definition.key] = role;
    }
    return roles;
  }

  ensureLocalOrganization(config) {
    const organizationId = identifier(config.organization.id);
    const name = text(config.organization.name, 'name', { minimum: 2, maximum: 120 });
    const code = station(config.site.code);
    const zone = timezone(config.timezone);
    const timestamp = this.now();
    return this.store.transaction(() => {
      let organization = this.store.organization(organizationId);
      if (!organization) {
        this.store.createOrganization({
          id: organizationId, name, abbreviation: null, timezone: zone, status: 'active',
          createdBy: null, timestamp,
        });
        this.store.insertStation(organizationId, code, true, timestamp);
        this.store.createInstallation(
          organizationId, 'local', 'ready', timestamp, 'dispatch_current_1', 'local_reference',
        );
      }
      this.ensureSystemRoles(organizationId, null, timestamp);
      organization = this.store.organization(organizationId);
      return organization;
    });
  }

  bootstrapStatus() {
    this.store.expireInvitations(this.now());
    return {
      initialized: this.store.platformOwnerCount() > 0,
      invitationPending: Boolean(this.store.pendingPlatformInvitation()),
    };
  }

  createPlatformBootstrap({ email: emailValue, organizationId = null }) {
    const selectedEmail = email(emailValue);
    const selectedOrganization = organizationId === null ? null : identifier(organizationId);
    const timestamp = this.now();
    const rawToken = opaqueToken();
    let invitation;
    try {
      this.store.transaction(() => {
        this.store.expireInvitations(timestamp);
        if (this.store.platformOwnerCount() > 0) throw new AccessError('platform_already_initialized', 409);
        if (this.store.pendingPlatformInvitation()) throw new AccessError('platform_invitation_pending', 409);
        let roleId = null;
        if (selectedOrganization) {
          const organization = this.store.organization(selectedOrganization);
          if (!organization) throw new AccessError('organization_not_found', 404);
          roleId = this.store.roleByKey(selectedOrganization, 'owner')?.id;
          if (!roleId) throw new AccessError('role_not_found', 500);
        }
        invitation = this.store.createInvitation({
          id: id('inv'), kind: 'platform_owner', organizationId: selectedOrganization, roleId,
          email: selectedEmail, tokenHash: tokenHash(rawToken), expiresAt: timestamp + this.invitationTtlMs,
          createdBy: null, timestamp,
        });
        this.audit({
          organizationId: selectedOrganization, action: 'platform.bootstrap.invitation.create',
          targetType: 'invitation', targetId: invitation.id, timestamp,
        });
      });
    } catch (error) { throw safeConflict(error); }
    return { invitation, token: rawToken };
  }

  revokePlatformBootstrap() {
    const timestamp = this.now();
    return this.store.transaction(() => {
      this.store.expireInvitations(timestamp);
      const invitation = this.store.pendingPlatformInvitation();
      if (!invitation) return null;
      this.store.revokeInvitation(invitation.id);
      this.audit({
        organizationId: invitation.organization_id, action: 'platform.bootstrap.invitation.revoke',
        targetType: 'invitation', targetId: invitation.id, timestamp,
      });
      return this.store.invitationById(invitation.id);
    });
  }

  invitation(rawToken) {
    token(rawToken);
    const row = this.store.invitationByHash(tokenHash(rawToken));
    const timestamp = this.now();
    if (!row || row.status !== 'pending' || row.expires_at <= timestamp) throw new AccessError('invitation_invalid', 404);
    if (row.organization_id && this.removalStarted(row.organization_id)) throw new AccessError('invitation_invalid', 404);
    return row;
  }

  inspectInvitation(rawToken) {
    const row = this.invitation(rawToken);
    return {
      kind: row.kind,
      organization: row.organization_id ? { name: row.organization_name } : null,
      role: row.role_id ? { name: row.role_name } : null,
      email: maskedEmail(row.email),
      accountExists: Boolean(this.store.userByEmail(row.email)),
      expiresAt: iso(row.expires_at),
    };
  }

  createSession(userId) {
    const user = this.store.userById(userId);
    if (!user || user.status !== 'active') throw new AccessError('account_disabled', 403);
    const memberships = this.availableMemberships(userId);
    if (user.platform_role !== 'owner' && this.membershipAccessBlocked(userId, memberships)) throw new AccessError('account_disabled', 403);
    const rawToken = opaqueToken();
    const csrfToken = opaqueToken();
    const timestamp = this.now();
    this.store.deleteExpiredSessions(timestamp);
    this.store.createSession({
      tokenHash: tokenHash(rawToken), userId, csrfToken,
      activeOrganizationId: user.platform_role === 'owner' ? null : memberships[0]?.organizationId || null,
      authVersion: user.auth_version, expiresAt: timestamp + this.sessionTtlMs, timestamp,
    });
    return { token: rawToken, expiresAt: timestamp + this.sessionTtlMs, session: this.session(rawToken) };
  }

  session(rawToken) {
    if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const hash = tokenHash(rawToken);
    const session = this.store.session(hash, this.now());
    if (!session) return null;
    const memberships = this.availableMemberships(session.userId);
    if (session.user.platformRole !== 'owner' && this.membershipAccessBlocked(session.userId, memberships)) {
      this.store.deleteSession(hash);
      return null;
    }
    if (session.activeOrganizationId && !memberships.some(item => item.organizationId === session.activeOrganizationId)) {
      session.activeOrganizationId = memberships[0]?.organizationId || null;
      this.store.selectOrganization(hash, session.activeOrganizationId, this.now());
    }
    this.store.touchSession(hash, this.now());
    return {
      tokenHash: hash,
      csrfToken: session.csrfToken,
      expiresAt: iso(session.expiresAt),
      user: session.user,
      platformPermissions: session.user.platformRole === 'owner' ? PLATFORM_PERMISSIONS : [],
      activeOrganizationId: session.activeOrganizationId,
      memberships,
    };
  }

  requireSession(rawToken) {
    const session = this.session(rawToken);
    if (!session) throw new AccessError('authentication_required', 401);
    return session;
  }

  availableMemberships(userId) {
    return this.store.membershipsForUser(userId).filter(item => item.organization?.status !== 'suspended'
      && !this.removalStarted(item.organizationId));
  }

  membershipAccessBlocked(userId, available) {
    return available.length === 0 && Boolean(this.store.db.prepare('SELECT 1 FROM memberships WHERE user_id=? LIMIT 1').get(userId));
  }

  async signIn({ email: emailValue, password: passwordValue }) {
    let selectedEmail;
    try { selectedEmail = email(emailValue); } catch {
      await consumeEquivalentPasswordWork(typeof passwordValue === 'string' ? passwordValue : '');
      throw new AccessError('invalid_credentials', 401);
    }
    const user = this.store.userByEmail(selectedEmail);
    if (!user) {
      await consumeEquivalentPasswordWork(typeof passwordValue === 'string' ? passwordValue : '');
      throw new AccessError('invalid_credentials', 401);
    }
    if (typeof passwordValue !== 'string') {
      await consumeEquivalentPasswordWork('');
      throw new AccessError('invalid_credentials', 401);
    }
    const valid = await verifyPassword(passwordValue, user.password_hash);
    if (!valid || user.status !== 'active') throw new AccessError('invalid_credentials', 401);
    return this.store.transaction(() => {
      const current = this.store.userById(user.id);
      if (!current || current.status !== 'active' || current.email !== selectedEmail
          || current.auth_version !== user.auth_version) throw new AccessError('invalid_credentials', 401);
      this.audit({ actorUserId: user.id, action: 'session.login', targetType: 'user', targetId: user.id });
      return this.createSession(user.id);
    });
  }

  signOut(session) {
    this.store.deleteSession(session.tokenHash);
    this.audit({ actorUserId: session.user.id, organizationId: session.activeOrganizationId, action: 'session.logout', targetType: 'user', targetId: session.user.id });
  }

  requestPasswordReset(input) { return require('./password-recovery').requestPasswordReset.call(this, input); }

  resetPassword(input) { return require('./password-recovery').resetPassword.call(this, input); }

  async changePassword(session, input) {
    exact(input, ['currentPassword', 'newPassword', 'confirmPassword']);
    const user = this.store.userById(session.user.id);
    if (!user || typeof input.currentPassword !== 'string' || !await verifyPassword(input.currentPassword, user.password_hash)) {
      throw new AccessError('current_password_invalid', 403);
    }
    password(input.newPassword);
    if (input.newPassword !== input.confirmPassword) throw new AccessError('password_confirmation_mismatch');
    if (input.newPassword === input.currentPassword) throw new AccessError('password_unchanged', 409);
    const passwordHash = await hashPassword(input.newPassword);
    const timestamp = this.now();
    this.store.transaction(() => {
      const current = this.store.userById(user.id);
      if (!current || current.auth_version !== user.auth_version || current.status !== 'active') {
        throw new AccessError('authentication_required', 401);
      }
      this.store.updatePassword(user.id, passwordHash, timestamp);
      this.store.deleteUserSessions(user.id);
      this.audit({ actorUserId: user.id, organizationId: session.activeOrganizationId, action: 'account.password.change', targetType: 'user', targetId: user.id, timestamp });
    });
    return this.createSession(user.id);
  }

  selectMembership(session, membershipId) {
    const selectedMembershipId = identifier(membershipId);
    const membership = session.memberships.find(candidate => candidate.id === selectedMembershipId && candidate.status === 'active');
    if (!membership) throw new AccessError('membership_not_found', 404);
    const organizationId = membership.organization.id;
    this.store.selectOrganization(session.tokenHash, organizationId, this.now());
    return this.sessionByHash(session.tokenHash);
  }

  sessionByHash(hash) {
    const record = this.store.session(hash, this.now());
    if (!record) throw new AccessError('authentication_required', 401);
    const memberships = this.store.membershipsForUser(record.userId);
    return {
      tokenHash: hash, csrfToken: record.csrfToken, expiresAt: iso(record.expiresAt), user: record.user,
      platformPermissions: record.user.platformRole === 'owner' ? PLATFORM_PERMISSIONS : [],
      activeOrganizationId: record.activeOrganizationId, memberships,
    };
  }

  async acceptNewUser({ token: rawToken, firstName, lastName, password: passwordValue, confirmPassword }) {
    const invitation = this.invitation(rawToken);
    const selectedFirstName = text(firstName, 'firstName', { maximum: 80 });
    const selectedLastName = text(lastName, 'lastName', { maximum: 80 });
    password(passwordValue);
    if (passwordValue !== confirmPassword) throw new AccessError('password_confirmation_mismatch');
    if (this.store.userByEmail(invitation.email)) throw new AccessError('account_exists', 409);
    const passwordHash = await hashPassword(passwordValue);
    const timestamp = this.now();
    let user;
    try {
      user = this.store.transaction(() => {
        const current = this.invitation(rawToken);
        if (this.store.userByEmail(current.email)) throw new AccessError('account_exists', 409);
        const userId = id('usr');
        const created = this.store.insertUser({
          id: userId, email: current.email, firstName: selectedFirstName, lastName: selectedLastName,
          passwordHash, platformRole: current.kind === 'platform_owner' ? 'owner' : null, timestamp,
        });
        this.applyInvitationMembership(current, userId, timestamp);
        this.store.acceptInvitation(current.id, userId, timestamp);
        this.audit({
          actorUserId: userId, organizationId: current.organization_id, action: 'invitation.accept',
          targetType: 'invitation', targetId: current.id, timestamp,
        });
        return created;
      });
    } catch (error) { throw safeConflict(error); }
    return this.createSession(user.id);
  }

  acceptExistingUser(session, rawToken) {
    const invitation = this.invitation(rawToken);
    if (session.user.email !== invitation.email) throw new AccessError('invitation_email_mismatch', 403);
    const timestamp = this.now();
    this.store.transaction(() => {
      const current = this.invitation(rawToken);
      if (current.kind === 'platform_owner') this.store.setPlatformRole(session.user.id, 'owner', timestamp);
      this.applyInvitationMembership(current, session.user.id, timestamp);
      this.store.acceptInvitation(current.id, session.user.id, timestamp);
      if (current.organization_id) this.store.selectOrganization(session.tokenHash, current.organization_id, timestamp);
      this.audit({
        actorUserId: session.user.id, organizationId: current.organization_id, action: 'invitation.accept',
        targetType: 'invitation', targetId: current.id, timestamp,
      });
    });
    return this.sessionByHash(session.tokenHash);
  }

  applyInvitationMembership(invitation, userId, timestamp) {
    if (!invitation.organization_id) return;
    if (this.store.membership(userId, invitation.organization_id)) throw new AccessError('membership_exists', 409);
    this.store.createMembership({
      id: id('mem'), organizationId: invitation.organization_id, userId, roleId: invitation.role_id,
      createdBy: invitation.created_by, timestamp,
    });
    if (invitation.kind === 'organization_owner' || invitation.kind === 'platform_owner') {
      const organization = this.store.organization(invitation.organization_id);
      let installation = this.store.installationControl(invitation.organization_id);
      if (installation?.status === 'waiting_for_owner' && installation.currentJobId === null) {
        installationTransition('waiting_for_owner', 'waiting_for_provider_auth');
        installation = this.store.updateInstallationControl({
          organizationId: invitation.organization_id,
          expectedStatus: 'waiting_for_owner',
          expectedRevision: installation.revision,
          status: 'waiting_for_provider_auth',
          revision: installation.revision + 1,
          currentJobId: null,
          timestamp,
        });
      }
      if (organization?.status !== 'suspended') {
        this.store.updateOrganizationStatus(invitation.organization_id, installation?.status === 'ready' ? 'active' : 'setup_required', timestamp);
        require('./workspace-readiness').completeWorkspaceSetup(this.store, () => timestamp);
      }
    }
  }

  requirePlatform(session, permission) {
    if (session.dspView) throw new AccessError('dsp_view_scope', 403);
    if (!session.platformPermissions.includes(permission)) throw new AccessError('platform_forbidden', 403);
  }

  beginDspView(session, input) {
    this.requirePlatform(session, 'platform.organizations.read');
    exact(input, ['controlRef']);
    const { organizationId } = this.resolvePlatformControl(session, input.controlRef);
    const viewRef = this.issuePlatformControlRef(session, organizationId, 'dispatch_dsp_owner_view_v1');
    const viewed = this.dspViewSession(session, viewRef);
    this.audit({ actorUserId: session.user.id, organizationId,
      action: 'organization.view.start', targetType: 'organization', targetId: organizationId });
    return viewed;
  }

  dspViewSession(session, viewRef) {
    let target;
    try {
      this.requirePlatform(session, 'platform.organizations.read');
      target = this.resolvePlatformControl(session, viewRef, 'dispatch_dsp_owner_view_v1');
    }
    catch (error) {
      if (error instanceof AccessError) throw new AccessError('dsp_view_unavailable', 403);
      throw error;
    }
    const { organizationId, organization } = target;
    const role = this.store.roleByKey(organizationId, 'owner');
    if (!role || organization.status === 'suspended' || this.removalStarted(organizationId)) {
      throw new AccessError('dsp_view_unavailable', 403);
    }
    const membership = {
      id: `view_${organizationId}`, organizationId, roleId: role.id,
      roleKey: 'owner', roleName: 'Owner', status: 'active',
      permissions: role.permissions, organization,
    };
    return { ...session, activeOrganizationId: organizationId, memberships: [membership],
      dspView: { viewRef, access: 'owner',
        expiresAt: iso(Number(Buffer.from(viewRef, 'base64url').readBigUInt64BE())) } };
  }

  dspViewContext(session, organizationId, permission = null) {
    // Revalidate the signed, session-bound scope and current DSP state on every access.
    const current = this.sessionByHash(session.tokenHash);
    const viewed = this.dspViewSession(current, session.dspView.viewRef);
    if (viewed.activeOrganizationId !== organizationId) throw new AccessError('organization_forbidden', 403);
    const membership = viewed.memberships[0];
    if (permission !== null && !membership.permissions.includes(permission)) throw new AccessError('organization_forbidden', 403);
    if (permission !== null && !permission.endsWith('.read')) this.requireBackupIdle(organizationId);
    return { membership, organization: membership.organization };
  }

  removalStarted(organizationId) {
    if (this.store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(organizationId)) return true;
    const installation = this.store.installationControl(organizationId);
    if (!installation) return false;
    if (['decommissioning', 'decommissioned'].includes(installation.status)) return true;
    const job = installation.currentJobId ? this.store.lifecycleJob(installation.currentJobId) : null;
    return Boolean(job && ['decommission', 'destroy'].includes(job.operation));
  }

  requireBackupIdle(organizationId) {
    if (this.store.db.prepare("SELECT 1 FROM platform_backup_requests WHERE organization_id=? AND status IN ('queued','running')").get(organizationId)
        || ['backup','restore','upgrade','decommission','destroy'].includes(this.store.activeLifecycleJob(organizationId)?.operation)) {
      throw new AccessError('backup_operation_in_progress', 409);
    }
  }

  requirePermission(session, organizationId, permission) {
    if (session.dspView) return this.dspViewContext(session, organizationId, permission);
    const selected = identifier(organizationId);
    const membership = this.store.membership(session.user.id, selected);
    const organization = this.store.organization(selected);
    if (!membership || membership.status !== 'active' || !organization || organization.status === 'suspended' || this.removalStarted(selected)
        || !membership.permissions.includes(permission)) throw new AccessError('organization_forbidden', 403);
    if (!permission.endsWith('.read')) this.requireBackupIdle(selected);
    return { membership, organization };
  }

  organizationMembership(session) {
    if (session.dspView) return this.dspViewContext(session, session.activeOrganizationId);
    if (!session.activeOrganizationId) throw new AccessError('organization_required', 409);
    const selected = identifier(session.activeOrganizationId);
    const membership = this.store.membership(session.user.id, selected);
    const organization = this.store.organization(selected);
    if (!membership || membership.status !== 'active' || !organization || organization.status === 'suspended' || this.removalStarted(selected)) {
      throw new AccessError('organization_forbidden', 403);
    }
    return { membership, organization };
  }

  organizationFor(session, permission) {
    if (session.dspView) return this.dspViewContext(session, session.activeOrganizationId, permission);
    const context = this.organizationMembership(session);
    if (!permission.endsWith('.read')) this.requireBackupIdle(context.organization.id);
    if (!context.membership.permissions.includes(permission)) throw new AccessError('organization_forbidden', 403);
    return context;
  }

  requireDspOwner(session) {
    // Credential operations must use a current login and the authenticated DSP
    // scope. Platform owners receive the same authority through their signed view.
    const current = this.sessionByHash(session.tokenHash);
    const selected = session.dspView ? this.dspViewSession(current, session.dspView.viewRef) : current;
    if (current.user.id !== session.user.id || selected.activeOrganizationId !== session.activeOrganizationId) {
      throw new AccessError('organization_forbidden', 403);
    }
    const context = this.organizationFor(selected, 'organization.owner');
    if (context.membership.roleKey !== 'owner') throw new AccessError('permission_denied', 403);
    return context;
  }

  runtimeFor(session, permission = null) {
    const context = permission === null ? this.organizationMembership(session) : this.organizationFor(session, permission);
    const installation = this.store.installation(context.organization.id);
    if (context.organization.status !== 'active' || !installation || installation.status !== 'ready') {
      throw new AccessError('installation_not_ready', 409);
    }
    return { ...context, installation };
  }

  issuePlatformControlRef(session, organizationId, purpose = 'dispatch_platform_control_v1') {
    const timestamp = this.now();
    const sessionExpiry = Date.parse(session.expiresAt);
    const expiresAt = Math.min(timestamp + PLATFORM_CONTROL_TTL_MS, sessionExpiry);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= timestamp) throw new AccessError('authentication_required', 401);
    // Keep listing read-only while lifecycle workers hold the database writer lock.
    // The session-bound MAC hides the organization identity and authenticates expiry.
    const expiry = Buffer.alloc(8);
    expiry.writeBigUInt64BE(BigInt(expiresAt));
    return Buffer.concat([expiry, platformControlMac(session, organizationId, expiry, purpose)]).toString('base64url');
  }

  resolvePlatformControl(session, rawReference, purpose = 'dispatch_platform_control_v1') {
    controlReference(rawReference);
    const row = purpose === 'dispatch_platform_control_v1' ? this.store.platformTargetRef(tokenHash(rawReference)) : null;
    // Honor references issued before this upgrade until their original expiry.
    if (row) {
      if (row.session_hash !== session.tokenHash || row.user_id !== session.user.id
        || row.purpose !== 'organization_control' || row.expires_at <= this.now()) {
        throw new AccessError('platform_control_invalid', 404);
      }
      const organization = this.store.organization(row.organization_id);
      if (!organization) throw new AccessError('platform_control_invalid', 404);
      return { organizationId: row.organization_id, organization };
    }
    const bytes = Buffer.from(rawReference, 'base64url');
    if (bytes.length === 32 && bytes.toString('base64url') === rawReference) {
      const expiresAt = Number(bytes.readBigUInt64BE());
      if (Number.isSafeInteger(expiresAt) && expiresAt > this.now() && expiresAt <= Date.parse(session.expiresAt)) {
        for (const { id: organizationId } of this.store.db.prepare('SELECT id FROM organizations').all()) {
          if (crypto.timingSafeEqual(bytes.subarray(8), platformControlMac(session, organizationId, bytes.subarray(0, 8), purpose))) {
            return { organizationId, organization: this.store.organization(organizationId) };
          }
        }
      }
    }
    throw new AccessError('platform_control_invalid', 404);
  }

  runPlatformMutation({ session, action, idempotencyKey: keyValue, digestValue, organizationId = null, execute, replay }) {
    const key = idempotencyKey(keyValue);
    const digest = valueDigest(digestValue);
    return this.store.transaction(() => {
      const prior = this.store.platformMutationRequest(session.user.id, action, key);
      if (prior) {
        if (prior.request_digest !== digest) throw new AccessError('idempotency_conflict', 409);
        return replay(storedResult(prior), true);
      }
      const completed = execute();
      this.store.createPlatformMutationRequest({
        id: id('pmr'),
        actorUserId: session.user.id,
        action,
        idempotencyKey: key,
        requestDigest: digest,
        organizationId: completed.organizationId ?? organizationId,
        result: completed.record,
        timestamp: this.now(),
      });
      return completed.result;
    });
  }

  installationConsoleStatus(organizationId) {
    const control = this.store.installationControl(organizationId);
    if (!control) throw new AccessError('installation_not_found', 404);
    const provisioning = this.store.latestProvisioningRequest(organizationId);
    const latestActivation = this.store.latestActivationJob(organizationId);
    const activation = latestActivation?.authority_scope === 'optional_paycom' ? null : latestActivation;
    let provisioningOperation = null;
    if (provisioning) {
      let operation;
      try { operation = JSON.parse(provisioning.request_json)?.operation; } catch {}
      if (!['provision', 'retry'].includes(operation)) throw new AccessError('access_schema_incompatible', 500);
      provisioningOperation = {
        kind: operation,
        status: provisioning.status,
        failureCode: provisioning.failure_code,
        updatedAt: provisioning.updated_at,
      };
    }
    const activationOperation = activation ? {
      kind: 'activation',
      status: activation.status,
      failureCode: activation.failure_code,
      updatedAt: activation.updated_at,
    } : null;
    let selected = null;
    if (control.status === 'provisioning') selected = provisioningOperation;
    else if (['waiting_for_owner', 'waiting_for_provider_auth'].includes(control.status)) {
      selected = provisioningOperation || activationOperation;
    } else if (['verifying', 'ready'].includes(control.status)) {
      selected = activationOperation || provisioningOperation;
    } else if (control.status === 'failed'
        && provisioning?.provisioner_job_id === control.currentJobId) {
      selected = provisioningOperation;
    } else if (control.status === 'failed' && activation?.id === control.currentJobId) {
      selected = activationOperation;
    } else if (activationOperation
        && (!provisioningOperation || activationOperation.updatedAt >= provisioningOperation.updatedAt)) {
      selected = activationOperation;
    } else {
      selected = provisioningOperation;
    }
    const lifecycle = control.currentJobId ? this.store.lifecycleJob(control.currentJobId) : null;
    if (lifecycle && ['decommission', 'destroy', 'upgrade', 'resume'].includes(lifecycle.operation)) {
      selected = { kind: lifecycle.operation === 'resume' && this.removalStarted(organizationId) ? 'restore_dsp' : lifecycle.operation, status: lifecycle.status, failureCode: lifecycle.failure_code };
    }
    let failure = selected?.status === 'failed' ? installationFailure(selected.failureCode) : null;
    if (control.status === 'failed' && failure === null) {
      failure = installationFailure('installation_operation_failed');
    }
    const availableActions = [];
    if (this.installationOperatorEnabled && control.status === 'pending') availableActions.push('provision');
    const provisionFailure = provisioning?.status === 'failed' ? installationFailure(provisioning.failure_code) : null;
    if (this.installationOperatorEnabled && control.status === 'failed' && provisioning?.status === 'failed'
        && provisioning.provisioner_job_id === control.currentJobId
        && provisionFailure.recoverable && provisionFailure.category === 'infrastructure') {
      availableActions.push('retry_provision');
    }
    const managed = !['local_reference', 'directory_service_v1'].includes(this.store.installationBackend(organizationId));
    if (this.installationOperatorEnabled && managed && (!this.store.activeLifecycleJob(organizationId) || this.store.activeLifecycleJob(organizationId).operation === 'backup')) {
      const removal = this.store.db.prepare('SELECT * FROM dsp_removals WHERE organization_id=?').get(organizationId);
      if ((['pending', 'waiting_for_owner', 'waiting_for_provider_auth', 'ready', 'suspended', 'failed'].includes(control.status) || this.store.activeLifecycleJob(organizationId)?.operation === 'backup')
          && !removal && lifecycle?.operation !== 'destroy') availableActions.push('decommission');
      if (removal && lifecycle?.operation === 'decommission' && lifecycle.status === 'failed') availableActions.push('decommission');
      if ((control.status === 'decommissioned' || removal && lifecycle?.operation === 'destroy' && lifecycle.status === 'failed') && !(lifecycle?.operation === 'destroy' && lifecycle.status === 'succeeded')) availableActions.push('destroy');
      if (removal && control.status === 'decommissioned' && lifecycle?.operation !== 'destroy') availableActions.push('restore_dsp');
    }
    const projection = {
      state: control.status,
      revision: control.revision,
      operation: selected ? { kind: selected.kind, status: selected.status } : null,
      failure,
      availableActions,
    };
    const selectedProjection = this.directoryLifecycleFor(organizationId)?.projection(
      organizationId, projection, this.installationOperatorEnabled) || projection;
    return platformInstallationStatus(this.installationOperatorEnabled && this.directoryLifecycleFor(organizationId)
      && this.directoryDeletion ? this.directoryDeletion.projection(organizationId, selectedProjection) : selectedProjection);
  }

  directoryLifecycleFor(organizationId) {
    return this.store.installationBackend(organizationId) === 'directory_service_v1'
      ? require('./directory-lifecycle').createDirectoryLifecycle({ store: this.store, clock: () => this.now() }) : null;
  }

  requestPlatformRuntime(session, input, action) {
    this.requirePlatform(session, 'platform.installations.manage');
    if (!this.installationOperatorEnabled) throw new AccessError('installation_operator_disabled', 503);
    exact(input, ['controlRef', 'idempotencyKey', 'expectedRevision']);
    const target = this.resolvePlatformControl(session, input.controlRef);
    const authority = this.directoryLifecycleFor(target.organizationId);
    if (!authority) throw new AccessError('installation_operation_not_allowed', 409);
    return authority.request({ organizationId: target.organizationId, actorUserId: session.user.id,
      action, expectedRevision: input.expectedRevision, requestId: input.idempotencyKey });
  }

  platformOrganizationView(session, organization) {
    const invitations = this.store.invitations(organization.id)
      .filter(invitation => invitation.kind === 'organization_owner' && invitation.status === 'pending'
        && Date.parse(invitation.expiresAt) > this.now());
    const invitation = invitations[0] || null;
    const ownerActive = this.store.activeOwnerCount(organization.id) > 0;
    const platformPermissions = session.platformPermissions;
    const canManageInvitations = platformPermissions.includes('platform.invitations.manage');
    const canManageInstallation = platformPermissions.includes('platform.installations.manage');
    const projectedInstallation = this.installationConsoleStatus(organization.id);
    const installation = canManageInstallation
      ? platformInstallationStatus({ ...projectedInstallation, availableActions: projectedInstallation.availableActions
        .filter(action => organization.status !== 'suspended' || ['decommission', 'destroy', 'restore_dsp', 'resume', 'suspend'].includes(action)) })
      : platformInstallationStatus({ ...projectedInstallation, availableActions: [] });
    const availableActions = [];
    const removed = this.removalStarted(organization.id);
    if (!removed && !ownerActive && canManageInvitations) {
      availableActions.push(invitation ? 'revoke_owner_invitation' : 'issue_owner_invitation');
    }
    const profile = this.store.db.prepare('SELECT * FROM organization_profiles WHERE organization_id=?').get(organization.id);
    const owner = this.store.db.prepare("SELECT u.email FROM users u JOIN memberships m ON m.user_id=u.id JOIN roles r ON r.id=m.role_id WHERE m.organization_id=? AND m.status='active' AND r.key='owner' ORDER BY m.created_at LIMIT 1").get(organization.id);
    return platformOrganization({
      ownerEmail: owner?.email || invitation?.email || profile?.owner_email || null,
      detailsStatus: !profile || profile.applied_at !== null ? 'complete' : profile.details_json ? 'submitted' : 'required',
      controlRef: this.issuePlatformControlRef(session, organization.id),
      continuityRef: platformContinuityRef(session.tokenHash, organization.id),
      name: organization.name,
      abbreviation: organization.abbreviation,
      timezone: organization.timezone,
      stations: organization.stations,
      memberCount: organization.memberCount || 0,
      organizationStatus: organization.status,
      ownerStatus: ownerActive ? 'active' : invitation ? 'pending' : 'missing',
      ownerInvitation: invitation ? { email: invitation.email, expiresAt: invitation.expiresAt } : null,
      installation,
      availableActions,
    });
  }

  organizationSetup(session) {
    if (!session.activeOrganizationId) throw new AccessError('organization_required', 409);
    const membership = session.dspView
      ? this.dspViewContext(session, session.activeOrganizationId, 'organization.owner').membership
      : this.store.membership(session.user.id, session.activeOrganizationId);
    const organization = this.store.organization(session.activeOrganizationId);
    if (!membership || membership.status !== 'active' || !organization
        || this.removalStarted(organization.id)
        || !membership.permissions.includes('organization.owner')) throw new AccessError('organization_forbidden', 403);
    const installation = this.installationConsoleStatus(organization.id);
    const setupState = ['pending', 'provisioning', 'waiting_for_owner'].includes(installation.state)
      ? 'waiting_for_platform'
      : installation.state === 'waiting_for_provider_auth'
        ? (['oci_container_v1', 'native_service_v1', 'directory_service_v1'].includes(this.store.installationBackend(organization.id)) ? 'owner_required' : 'server_owner_required')
        : installation.state === 'verifying' ? 'verification_in_progress'
          : installation.state === 'ready' ? 'ready' : 'unavailable';
    return organizationSetupStatus({
      organization: {
        name: organization.name,
        abbreviation: organization.abbreviation,
        stationCode: organization.stations[0].code,
        timezone: organization.timezone,
      },
      organizationStatus: organization.status,
      installationState: installation.state,
      setupState,
      handoff: setupState === 'server_owner_required'
        ? { status: 'required', audience: 'server_owner', channel: 'private_terminal' }
        : setupState === 'owner_required' ? { status: 'required', audience: 'dsp_owner', channel: 'dashboard' } : null,
      operationalAccess: organization.status === 'active' && installation.state === 'ready' ? 'available' : 'unavailable',
      failure: installation.state === 'failed'
        ? (installation.failure || installationFailure('installation_operation_failed')) : null,
    });
  }

  organizationProfile(session, input) {
    const { organization } = this.organizationFor(session, 'organization.owner');
    const db = this.store.db;
    if (input !== undefined) {
      exact(input, ['name', 'abbreviation', 'stationCode', 'timezone']);
      const details = { name: text(input.name, 'name', { minimum: 2, maximum: 120 }),
        abbreviation: abbreviation(input.abbreviation), stationCode: station(input.stationCode), timezone: timezone(input.timezone) };
      this.store.transaction(() => {
        this.organizationFor(session, 'organization.owner');
        const profile = db.prepare('SELECT * FROM organization_profiles WHERE organization_id=?').get(organization.id);
        if (!profile || profile.applied_at !== null) throw new AccessError('organization_details_complete', 409);
        db.prepare('UPDATE organization_profiles SET details_json=? WHERE organization_id=?').run(JSON.stringify(details), organization.id);
        this.audit({ actorUserId: session.user.id, organizationId: organization.id,
          action: 'organization.details.submit', targetType: 'organization', targetId: organization.id });
      });
      require('./organization-profile').applyOrganizationProfiles(this.store, () => this.now());
    }
    const profile = db.prepare('SELECT * FROM organization_profiles WHERE organization_id=?').get(organization.id);
    return { status: !profile || profile.applied_at !== null ? 'complete' : profile.details_json ? 'submitted' : 'required',
      details: profile?.details_json ? JSON.parse(profile.details_json) : null };
  }

  createOrganization(session, input) {
    this.requirePlatform(session, 'platform.organizations.create');
    exact(input, ['idempotencyKey', 'name', 'abbreviation', 'stationCode', 'timezone', 'ownerEmail']);
    const emailOnly = input.name === undefined && input.stationCode === undefined && input.timezone === undefined;
    if (emailOnly) {
      this.requirePlatform(session, 'platform.installations.manage');
      if (!this.installationOperatorEnabled) throw new AccessError('installation_operator_disabled', 503);
      if (!['oci_container_v1', 'native_service_v1', 'directory_service_v1'].includes(this.installationBackend)) throw new AccessError('container_provisioning_required', 409);
      input = { ...input, name: 'New DSP', stationCode: 'NEW', timezone: 'UTC' };
    }
    const selected = {
      emailOnly,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      name: text(input.name, 'name', { minimum: 2, maximum: 120 }),
      abbreviation: abbreviation(input.abbreviation),
      stationCode: station(input.stationCode),
      timezone: timezone(input.timezone),
      ownerEmail: email(input.ownerEmail),
    };
    try {
      return this.runPlatformMutation({
        session,
        action: 'organization.create',
        idempotencyKey: selected.idempotencyKey,
        digestValue: selected,
        execute: () => {
          const timestamp = this.now();
          const organizationId = id('org');
          const rawToken = opaqueToken();
          this.store.expireInvitations(timestamp);
          this.store.createOrganization({
            id: organizationId, name: selected.name, abbreviation: selected.abbreviation,
            timezone: selected.timezone, status: 'pending_owner', createdBy: session.user.id, timestamp,
          });
          this.store.insertStation(organizationId, selected.stationCode, true, timestamp);
          this.store.createInstallation(
            organizationId,
            `${this.installationBackend === 'directory_service_v1' ? 'dsp' : 'runtime'}_${organizationId.slice(4)}`,
            'pending',
            timestamp,
            this.store.db.prepare("SELECT r.release_id FROM platform_rollouts r JOIN platform_rollout_core c ON c.rollout_id=r.id WHERE c.status='succeeded' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1").get()?.release_id || 'dispatch_current_1',
            this.installationBackend,
          );
          if (emailOnly) {
            this.store.db.prepare('INSERT INTO organization_profiles(organization_id,owner_email) VALUES(?,?)').run(organizationId, selected.ownerEmail);
            const request = this.store.createProvisioningRequest({
              id: id('prq'), organizationId, authorityScope: 'platform_installation',
              operation: { operation: 'provision', idempotencyKey: `create:${organizationId}`, expectedRevision: 1 }, timestamp,
            });
            this.audit({ actorUserId: session.user.id, organizationId, action: 'installation.provision.request',
              targetType: 'installation_request', targetId: request.row.id, timestamp });
          }
          const roles = this.ensureSystemRoles(organizationId, session.user.id, timestamp);
          const invitation = this.store.createInvitation({
            id: id('inv'), kind: 'organization_owner', organizationId, roleId: roles.owner.id,
            email: selected.ownerEmail, tokenHash: tokenHash(rawToken), expiresAt: timestamp + this.invitationTtlMs,
            createdBy: session.user.id, timestamp,
          });
          this.audit({
            actorUserId: session.user.id, organizationId, action: 'organization.create',
            targetType: 'organization', targetId: organizationId, timestamp,
          });
          return {
            organizationId,
            record: { organizationId, invitationId: invitation.id },
            result: { organization: this.store.organization(organizationId), invitation, token: rawToken, replayed: false },
          };
        },
        replay: record => {
          if (Object.keys(record).sort().join(',') !== 'invitationId,organizationId') {
            throw new AccessError('access_schema_incompatible', 500);
          }
          const organization = this.store.organization(record.organizationId);
          const invitation = this.store.invitationById(record.invitationId);
          if (!organization || !invitation || invitation.organizationId !== organization.id) {
            throw new AccessError('access_schema_incompatible', 500);
          }
          return { organization, invitation, token: null, replayed: true };
        },
      });
    } catch (error) { throw safeConflict(error); }
  }

  platformOrganizations(session) {
    this.requirePlatform(session, 'platform.organizations.read');
    return this.store.organizations().filter(organization => {
      const control = this.store.installationControl(organization.id);
      const job = control?.currentJobId ? this.store.lifecycleJob(control.currentJobId) : null;
      return !(job?.operation === 'destroy' && job.status === 'succeeded' && this.store.installationBackend(organization.id) !== 'native_service_v1');
    }).map(organization => this.platformOrganizationView(session, organization));
  }

  platformDiagnostics(session, input) {
    this.requirePlatform(session, 'platform.installations.manage');
    if (session.user.platformRole !== 'owner') throw new AccessError('platform_forbidden', 403);
    if (input !== undefined) {
      exact(input, ['idempotencyKey']);
      const key = idempotencyKey(input.idempotencyKey);
      if (!this.installationOperatorEnabled || !['native_service_v1', 'directory_service_v1'].includes(this.installationBackend)) {
        throw new AccessError('installation_operator_disabled', 503);
      }
      this.store.transaction(() => {
        if (this.store.db.prepare('SELECT 1 FROM diagnostic_dsps WHERE actor_user_id=? AND idempotency_key=?')
          .get(session.user.id, key)) return;
        const directoryMode = this.installationBackend === 'directory_service_v1';
        const ownerEmail = directoryMode ? `diagnostic-${crypto.randomBytes(16).toString('hex')}@example.test` : session.user.email;
        const created = this.createOrganization(session, { ownerEmail,
          idempotencyKey: `diagnostic:${tokenHash(key)}` });
        const organizationId = created.organization.id;
        if (created.replayed) throw new AccessError('idempotency_conflict', 409);
        const timestamp = this.now();
        const invitation = this.store.invitationByHash(tokenHash(created.token));
        let ownerId = session.user.id;
        if (directoryMode) {
          // A dedicated synthetic app identity lets the platform owner create
          // multiple test DSPs without joining their tenant memberships. There
          // is no known password and no invitation delivery or Linux account.
          ownerId = id('usr');
          this.store.insertUser({ id: ownerId, email: ownerEmail, firstName: 'Synthetic', lastName: 'Owner',
            passwordHash: `scrypt-v1$32768$8$1$${crypto.randomBytes(24).toString('base64url')}$${crypto.randomBytes(64).toString('base64url')}`,
            platformRole: null, timestamp });
        }
        this.applyInvitationMembership(invitation, ownerId, timestamp);
        this.store.acceptInvitation(invitation.id, ownerId, timestamp);
        const details = { name: `TEST DSP ${organizationId.slice(-8)}`, abbreviation: 'TEST', stationCode: 'TST1', timezone: 'UTC' };
        this.store.db.prepare('UPDATE organization_profiles SET details_json=? WHERE organization_id=?')
          .run(JSON.stringify(details), organizationId);
        this.store.db.prepare('UPDATE organizations SET name=? WHERE id=?').run(details.name, organizationId);
        this.store.db.prepare("INSERT INTO diagnostic_dsps VALUES(?,?,?,'pending',?)")
          .run(organizationId, session.user.id, key, timestamp);
        this.audit({ actorUserId: session.user.id, organizationId, action: 'diagnostics.create',
          targetType: 'organization', targetId: organizationId, timestamp });
      });
    }
    return {
      enabled: this.installationOperatorEnabled && ['native_service_v1', 'directory_service_v1'].includes(this.installationBackend),
      dsps: this.store.db.prepare(`SELECT d.*,o.name,i.status AS installation_status FROM diagnostic_dsps d
        JOIN organizations o ON o.id=d.organization_id JOIN installations i ON i.organization_id=d.organization_id
        ORDER BY d.created_at DESC`).all().map(row => ({
        name: row.name, createdAt: iso(row.created_at),
        status: row.status === 'pending' && row.installation_status === 'failed' ? 'failed' : row.status,
        installation: this.installationConsoleStatus(row.organization_id),
      })),
    };
  }

  requestInstallationProvisioning(session, organizationId, input) {
    this.requirePlatform(session, 'platform.installations.manage');
    if (!this.installationOperatorEnabled) throw new AccessError('installation_operator_disabled', 503);
    exact(input, ['idempotencyKey', 'expectedRevision']);
    const authority = createAccessInstallationProvisioningAuthority({
      store: this.store,
      organizationId: identifier(organizationId),
      authorityScope: 'platform_installation',
      actorUserId: session.user.id,
      clock: () => this.now(),
    });
    return authority.request({
      operation: 'provision',
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision,
    });
  }

  requestInstallationRetry(session, organizationId, input) {
    this.requirePlatform(session, 'platform.installations.manage');
    if (!this.installationOperatorEnabled) throw new AccessError('installation_operator_disabled', 503);
    exact(input, ['idempotencyKey', 'expectedRevision']);
    const selectedOrganizationId = identifier(organizationId);
    const selectedIdempotencyKey = idempotencyKey(input.idempotencyKey);
    const authorityScope = 'platform_installation';
    const authority = createAccessInstallationProvisioningAuthority({
      store: this.store,
      organizationId: selectedOrganizationId,
      authorityScope,
      actorUserId: session.user.id,
      clock: () => this.now(),
    });
    const existing = this.store.provisioningRequestByKey(
      selectedOrganizationId, authorityScope, selectedIdempotencyKey,
    );
    if (existing === null
        && !this.installationConsoleStatus(selectedOrganizationId).availableActions.includes('retry_provision')) {
      throw new AccessError('installation_operation_not_allowed', 409);
    }
    return authority.request({
      operation: 'retry',
      idempotencyKey: selectedIdempotencyKey,
      expectedRevision: input.expectedRevision,
    });
  }

  requestPlatformInstallationProvisioning(session, input) {
    this.requirePlatform(session, 'platform.installations.manage');
    exact(input, ['controlRef', 'idempotencyKey', 'expectedRevision']);
    const target = this.resolvePlatformControl(session, input.controlRef);
    const request = this.requestInstallationProvisioning(session, target.organizationId, {
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision,
    });
    const current = this.store.installationControl(target.organizationId);
    return platformInstallationReceipt({
      action: 'provision',
      status: request.replayed ? 'replayed' : 'accepted',
      installationState: current.status,
      installationRevision: current.revision,
      replayed: request.replayed,
    });
  }

  requestPlatformInstallationRetry(session, input) {
    this.requirePlatform(session, 'platform.installations.manage');
    exact(input, ['controlRef', 'idempotencyKey', 'expectedRevision']);
    const target = this.resolvePlatformControl(session, input.controlRef);
    const request = this.requestInstallationRetry(session, target.organizationId, {
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision,
    });
    const current = this.store.installationControl(target.organizationId);
    return platformInstallationReceipt({
      action: 'retry_provision',
      status: request.replayed ? 'replayed' : 'accepted',
      installationState: current.status,
      installationRevision: current.revision,
      replayed: request.replayed,
    });
  }

  async requestPlatformRemoval(session, input, operation) {
    this.requirePlatform(session, 'platform.installations.manage');
    if (!this.installationOperatorEnabled) throw new AccessError('installation_operator_disabled', 503);
    if (!['decommission', 'destroy', 'resume'].includes(operation)) throw new AccessError('invalid_input');
    exact(input, ['controlRef', 'idempotencyKey', 'expectedRevision', ...(operation === 'destroy' ? ['password'] : [])]);
    let user;
    if (operation === 'destroy') {
      user = this.store.userById(session.user.id);
      if (!user || typeof input.password !== 'string' || !await verifyPassword(input.password, user.password_hash)) {
        throw new AccessError('current_password_invalid', 403);
      }
    }
    return this.store.transaction(() => {
      // Password hashing yields: recheck session, credentials and permissions before mutation.
      if (user) {
        const current = this.store.userById(user.id);
        if (!current || current.auth_version !== user.auth_version || current.status !== 'active'
            || current.platform_role !== 'owner' || !this.store.session(session.tokenHash, this.now())) {
          throw new AccessError('authentication_required', 401);
        }
      }
      const target = this.resolvePlatformControl(session, input.controlRef);
      const directory = this.directoryLifecycleFor(target.organizationId);
      if (directory && operation === 'destroy' && this.directoryDeletion) return this.directoryDeletion.request({
        organizationId: target.organizationId, actorUserId: session.user.id, expectedRevision: input.expectedRevision,
        requestId: input.idempotencyKey });
      if (directory) return directory.request({ organizationId: target.organizationId, actorUserId: session.user.id,
        action: operation === 'resume' ? 'restore_dsp' : operation,
        expectedRevision: input.expectedRevision, requestId: input.idempotencyKey });
      if (operation === 'resume' && !this.store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(target.organizationId)
          && !this.store.lifecycleJobByRequest(target.organizationId, 'platform_removal', input.idempotencyKey)) {
        throw new AccessError('installation_operation_not_allowed', 409);
      }
      const authority = createAccessInstallationLifecycleAuthority({
        store: this.store, organizationId: target.organizationId,
        authorityScope: 'platform_removal', actorUserId: session.user.id,
        destructionEnabled: operation === 'destroy', clock: () => this.now(),
      });
      const result = authority.request({ operation, idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision });
      const current = this.store.installationControl(target.organizationId);
      return platformInstallationReceipt({
        action: operation === 'resume' ? 'restore_dsp' : operation, status: result.replayed ? 'replayed' : 'accepted',
        installationState: current.status, installationRevision: current.revision, replayed: result.replayed,
      });
    });
  }

  setOrganizationSuspended(session, organizationId, input) {
    this.requirePlatform(session, 'platform.organizations.suspend');
    exact(input, ['suspended']);
    if (typeof input.suspended !== 'boolean') throw new AccessError('invalid_request');
    const selected = identifier(organizationId);
    const timestamp = this.now();
    return this.store.transaction(() => {
      const organization = this.store.organization(selected);
      if (!organization) throw new AccessError('organization_not_found', 404);
      const installation = this.store.installationControl(selected);
      if (this.removalStarted(selected)) throw new AccessError('installation_operation_not_allowed', 409);
      this.requireBackupIdle(selected);
      if (['provisioning', 'waiting_for_provider_auth', 'verifying'].includes(installation?.status)) {
        throw new AccessError('installation_operation_in_progress', 409);
      }
      const resumedStatus = this.store.activeOwnerCount(selected) === 0
        ? 'pending_owner'
        : (installation?.status === 'ready' || installation?.status === 'suspended' && this.store.latestReadyEvidence(selected)) ? 'active' : 'setup_required';
      this.changeOrganizationRuntimeStatus(selected, installation, input.suspended ? 'suspended' : resumedStatus, session.user.id);
      this.audit({
        actorUserId: session.user.id, organizationId: selected,
        action: input.suspended ? 'organization.suspend' : 'organization.resume',
        targetType: 'organization', targetId: selected, timestamp,
      });
      return this.store.organization(selected);
    });
  }

  queueOrganizationStatusLifecycle(organizationId, installation, status) {
    if (!this.installationOperatorEnabled || !installation
        || !['oci_container_v1', 'native_service_v1'].includes(this.store.installationBackend(organizationId))) return;
    const operation = status === 'suspended' && installation.status === 'ready' ? 'suspend'
      : status === 'active' && installation.status === 'suspended' ? 'resume' : null;
    if (!operation) return;
    // Commit access revocation and its lifecycle job together. Otherwise the
    // agent loses its authority before the worker can inspect and stop it.
    createAccessInstallationLifecycleAuthority({ store: this.store, organizationId,
      authorityScope: 'organization_status_lifecycle', clock: () => this.now() }).request({
      operation, expectedRevision: installation.revision,
      idempotencyKey: `organization-status:${operation}:${installation.revision}`,
    });
  }

  changeOrganizationRuntimeStatus(organizationId, installation, status, actorUserId) {
    const directory = this.directoryLifecycleFor(organizationId);
    if (directory) {
      if (!this.installationOperatorEnabled) throw new AccessError('installation_operator_disabled', 503);
      const operation = status === 'suspended' ? 'suspend' : 'resume';
      directory.request({ organizationId, actorUserId, action: operation, expectedRevision: installation.revision,
        requestId: `organization-status:${operation}:${installation.revision}` });
    } else {
      this.store.updateOrganizationStatus(organizationId, status, this.now());
      this.queueOrganizationStatusLifecycle(organizationId, installation, status);
    }
    return this.store.organization(organizationId).status;
  }

  revokePlatformInvitation(session, invitationId) {
    this.requirePlatform(session, 'platform.invitations.manage');
    const selected = identifier(invitationId);
    const invitation = this.store.invitationById(selected);
    if (!invitation || invitation.kind !== 'organization_owner') throw new AccessError('invitation_not_found', 404);
    this.store.transaction(() => {
      this.store.revokeInvitation(selected);
      this.audit({
        actorUserId: session.user.id, organizationId: invitation.organizationId,
        action: 'invitation.revoke', targetType: 'invitation', targetId: selected,
      });
    });
  }

  createOwnerInvitation(session, organizationId, input) {
    this.requirePlatform(session, 'platform.invitations.manage');
    const selectedOrganizationId = identifier(organizationId);
    exact(input, ['ownerEmail']);
    const selectedEmail = email(input.ownerEmail);
    const rawToken = opaqueToken();
    const timestamp = this.now();
    let invitation;
    try {
      this.store.transaction(() => {
        this.store.expireInvitations(timestamp);
        const organization = this.store.organization(selectedOrganizationId);
        if (!organization) throw new AccessError('organization_not_found', 404);
        if (this.removalStarted(selectedOrganizationId)) throw new AccessError('installation_operation_not_allowed', 409);
        if (this.store.activeOwnerCount(selectedOrganizationId) > 0) throw new AccessError('organization_owner_exists', 409);
        if (this.store.invitations(selectedOrganizationId).some(candidate => candidate.kind === 'organization_owner' && candidate.status === 'pending')) {
          throw new AccessError('invitation_pending', 409);
        }
        if (this.store.pendingInvitationForEmail(selectedOrganizationId, selectedEmail)) throw new AccessError('invitation_pending', 409);
        const ownerRole = this.store.roleByKey(selectedOrganizationId, 'owner');
        if (!ownerRole) throw new AccessError('role_not_found', 500);
        invitation = this.store.createInvitation({
          id: id('inv'), kind: 'organization_owner', organizationId: selectedOrganizationId,
          roleId: ownerRole.id, email: selectedEmail, tokenHash: tokenHash(rawToken),
          expiresAt: timestamp + this.invitationTtlMs, createdBy: session.user.id, timestamp,
        });
        this.audit({
          actorUserId: session.user.id, organizationId: selectedOrganizationId,
          action: 'invitation.create', targetType: 'invitation', targetId: invitation.id, timestamp,
        });
      });
    } catch (error) { throw safeConflict(error); }
    return { invitation, token: rawToken };
  }

  setPlatformOrganizationSuspended(session, input) {
    this.requirePlatform(session, 'platform.organizations.suspend');
    exact(input, ['controlRef', 'idempotencyKey', 'suspended']);
    if (typeof input.suspended !== 'boolean') throw new AccessError('invalid_input');
    const target = this.resolvePlatformControl(session, input.controlRef);
    return this.runPlatformMutation({
      session,
      action: 'organization.status',
      idempotencyKey: input.idempotencyKey,
      digestValue: { organizationId: target.organizationId, suspended: input.suspended },
      organizationId: target.organizationId,
      execute: () => {
        const timestamp = this.now();
        const organization = this.store.organization(target.organizationId);
        const installation = this.store.installationControl(target.organizationId);
        if (!organization || !installation) throw new AccessError('platform_control_invalid', 404);
        if (this.removalStarted(target.organizationId)) throw new AccessError('installation_operation_not_allowed', 409);
        if (['provisioning', 'waiting_for_provider_auth', 'verifying'].includes(installation.status)) {
          throw new AccessError('installation_operation_in_progress', 409);
        }
        const resumedStatus = this.store.activeOwnerCount(target.organizationId) === 0
          ? 'pending_owner' : (installation.status === 'ready' || installation.status === 'suspended' && this.store.latestReadyEvidence(target.organizationId)) ? 'active' : 'setup_required';
        const status = this.changeOrganizationRuntimeStatus(target.organizationId, installation,
          input.suspended ? 'suspended' : resumedStatus, session.user.id);
        this.audit({
          actorUserId: session.user.id, organizationId: target.organizationId,
          action: input.suspended ? 'organization.suspend' : 'organization.resume',
          targetType: 'organization', targetId: target.organizationId, timestamp,
        });
        return {
          record: { organizationId: target.organizationId, status },
          result: { status, replayed: false },
        };
      },
      replay: record => {
        if (Object.keys(record).sort().join(',') !== 'organizationId,status'
            || record.organizationId !== target.organizationId || typeof record.status !== 'string') {
          throw new AccessError('access_schema_incompatible', 500);
        }
        return { status: record.status, replayed: true };
      },
    });
  }

  createPlatformOwnerInvitation(session, input) {
    this.requirePlatform(session, 'platform.invitations.manage');
    exact(input, ['controlRef', 'idempotencyKey', 'ownerEmail']);
    const target = this.resolvePlatformControl(session, input.controlRef);
    const selectedEmail = email(input.ownerEmail);
    try {
      return this.runPlatformMutation({
        session,
        action: 'owner_invitation.create',
        idempotencyKey: input.idempotencyKey,
        digestValue: { organizationId: target.organizationId, ownerEmail: selectedEmail },
        organizationId: target.organizationId,
        execute: () => {
          const timestamp = this.now();
          const rawToken = opaqueToken();
          this.store.expireInvitations(timestamp);
          if (this.removalStarted(target.organizationId)) throw new AccessError('installation_operation_not_allowed', 409);
          if (this.store.activeOwnerCount(target.organizationId) > 0) throw new AccessError('organization_owner_exists', 409);
          if (this.store.invitations(target.organizationId)
            .some(candidate => candidate.kind === 'organization_owner' && candidate.status === 'pending')) {
            throw new AccessError('invitation_pending', 409);
          }
          const ownerRole = this.store.roleByKey(target.organizationId, 'owner');
          if (!ownerRole) throw new AccessError('role_not_found', 500);
          const invitation = this.store.createInvitation({
            id: id('inv'), kind: 'organization_owner', organizationId: target.organizationId,
            roleId: ownerRole.id, email: selectedEmail, tokenHash: tokenHash(rawToken),
            expiresAt: timestamp + this.invitationTtlMs, createdBy: session.user.id, timestamp,
          });
          this.audit({
            actorUserId: session.user.id, organizationId: target.organizationId,
            action: 'invitation.create', targetType: 'invitation', targetId: invitation.id, timestamp,
          });
          return {
            record: { organizationId: target.organizationId, invitationId: invitation.id },
            result: { invitation, token: rawToken, replayed: false },
          };
        },
        replay: record => {
          if (Object.keys(record).sort().join(',') !== 'invitationId,organizationId'
              || record.organizationId !== target.organizationId) throw new AccessError('access_schema_incompatible', 500);
          const invitation = this.store.invitationById(record.invitationId);
          if (!invitation || invitation.organizationId !== target.organizationId) {
            throw new AccessError('access_schema_incompatible', 500);
          }
          return { invitation, token: null, replayed: true };
        },
      });
    } catch (error) { throw safeConflict(error); }
  }

  revokePlatformOwnerInvitation(session, input) {
    this.requirePlatform(session, 'platform.invitations.manage');
    exact(input, ['controlRef', 'idempotencyKey']);
    const target = this.resolvePlatformControl(session, input.controlRef);
    return this.runPlatformMutation({
      session,
      action: 'owner_invitation.revoke',
      idempotencyKey: input.idempotencyKey,
      digestValue: { organizationId: target.organizationId },
      organizationId: target.organizationId,
      execute: () => {
        const timestamp = this.now();
        this.store.expireInvitations(timestamp);
        const invitation = this.store.invitations(target.organizationId)
          .find(candidate => candidate.kind === 'organization_owner' && candidate.status === 'pending');
        if (!invitation) throw new AccessError('invitation_not_found', 404);
        this.store.revokeInvitation(invitation.id);
        this.audit({
          actorUserId: session.user.id, organizationId: target.organizationId,
          action: 'invitation.revoke', targetType: 'invitation', targetId: invitation.id, timestamp,
        });
        return {
          record: { organizationId: target.organizationId, invitationId: invitation.id },
          result: { status: 'revoked', replayed: false },
        };
      },
      replay: record => {
        if (Object.keys(record).sort().join(',') !== 'invitationId,organizationId'
            || record.organizationId !== target.organizationId) throw new AccessError('access_schema_incompatible', 500);
        return { status: 'revoked', replayed: true };
      },
    });
  }

  organizationAudit(session, organizationId) {
    this.requirePermission(session, organizationId, 'audit.read');
    return { audit: this.store.audits(organizationId, 100, { excludePlatformAccess: true }) };
  }

  organizationAdministration(session, organizationId) {
    const { organization, membership } = this.requirePermission(session, organizationId, 'members.read');
    this.store.expireInvitations(this.now());
    this.requirePermission(session, organizationId, 'roles.read');
    return {
      organization,
      membership,
      permissionCatalog: TENANT_PERMISSIONS,
      roles: this.store.roles(organizationId),
      members: this.store.members(organizationId),
      invitations: this.store.invitations(organizationId),
      audit: membership.permissions.includes('audit.read')
        ? this.organizationAudit(session, organizationId).audit : [],
    };
  }

  createRole(session, organizationId, input) {
    this.requirePermission(session, organizationId, 'roles.read');
    throw new AccessError('fixed_roles_only', 409);
  }

  updateRole(session, organizationId, roleId, input) {
    this.requirePermission(session, organizationId, 'roles.read');
    const role = this.store.role(identifier(roleId));
    if (!role || role.organizationId !== organizationId) throw new AccessError('role_not_found', 404);
    throw new AccessError('fixed_roles_only', 409);
  }

  deleteRole(session, organizationId, roleId) {
    this.requirePermission(session, organizationId, 'roles.read');
    const role = this.store.role(identifier(roleId));
    if (!role || role.organizationId !== organizationId) throw new AccessError('role_not_found', 404);
    throw new AccessError('fixed_roles_only', 409);
  }

  createMemberInvitation(session, organizationId, input) {
    const { membership } = this.requirePermission(session, organizationId, 'members.invite');
    exact(input, ['email', 'roleId']);
    const selectedEmail = email(input.email);
    const roleId = identifier(input.roleId);
    const rawToken = opaqueToken();
    const timestamp = this.now();
    let invitation;
    try {
      this.store.transaction(() => {
        this.store.expireInvitations(timestamp);
        const role = this.store.role(roleId);
        if (!role || role.organizationId !== organizationId || !role.system || !SYSTEM_ROLES.some(definition => definition.key === role.key)) throw new AccessError('role_not_assignable', 409);
        if (role.permissions.some(permission => !membership.permissions.includes(permission))) throw new AccessError('permission_escalation_forbidden', 403);
        const existingUser = this.store.userByEmail(selectedEmail);
        if (existingUser && this.store.membership(existingUser.id, organizationId)) throw new AccessError('membership_exists', 409);
        if (this.store.pendingInvitationForEmail(organizationId, selectedEmail)) throw new AccessError('invitation_pending', 409);
        invitation = this.store.createInvitation({
          id: id('inv'), kind: 'organization_member', organizationId, roleId,
          email: selectedEmail, tokenHash: tokenHash(rawToken), expiresAt: timestamp + this.invitationTtlMs,
          createdBy: session.user.id, timestamp,
        });
        this.audit({ actorUserId: session.user.id, organizationId, action: 'invitation.create', targetType: 'invitation', targetId: invitation.id, timestamp });
      });
    } catch (error) { throw safeConflict(error); }
    return { invitation, token: rawToken };
  }

  revokeMemberInvitation(session, organizationId, invitationId) {
    this.requirePermission(session, organizationId, 'members.invite');
    const selected = identifier(invitationId);
    const invitation = this.store.invitationById(selected);
    if (!invitation || invitation.organizationId !== organizationId || invitation.kind !== 'organization_member') throw new AccessError('invitation_not_found', 404);
    this.store.transaction(() => {
      this.store.revokeInvitation(selected);
      this.audit({ actorUserId: session.user.id, organizationId, action: 'invitation.revoke', targetType: 'invitation', targetId: selected });
    });
  }

  updateMemberRole(session, organizationId, membershipId, roleId) {
    this.store.transaction(() => {
      const { membership: actor } = this.requirePermission(session, organizationId, 'members.manage');
      const selectedMembershipId = identifier(membershipId);
      const selectedRoleId = identifier(roleId);
      const target = this.store.membershipById(selectedMembershipId);
      const currentRole = target ? this.store.role(target.role_id) : null;
      const role = this.store.role(selectedRoleId);
      if (!target || target.organization_id !== organizationId || !currentRole) throw new AccessError('member_not_found', 404);
      if (!role || role.organizationId !== organizationId || !role.system || !SYSTEM_ROLES.some(definition => definition.key === role.key)) throw new AccessError('role_not_assignable', 409);
      if (target.user_id === session.user.id) throw new AccessError('self_role_change_forbidden', 409);
      if (currentRole.permissions.some(permission => !actor.permissions.includes(permission))
          || role.permissions.some(permission => !actor.permissions.includes(permission))) {
        throw new AccessError('permission_escalation_forbidden', 403);
      }
      const timestamp = this.now();
      if (currentRole.key === 'owner' && role.key !== 'owner' && this.store.activeOwnerCount(organizationId) <= 1) {
        throw new AccessError('last_owner_protected', 409);
      }
      this.store.updateMembershipRole(selectedMembershipId, selectedRoleId, timestamp);
      this.audit({ actorUserId: session.user.id, organizationId, action: 'membership.role.update', targetType: 'membership', targetId: selectedMembershipId, timestamp });
    });
  }

  removeMember(session, organizationId, membershipId) {
    this.store.transaction(() => {
      const { membership: actor } = this.requirePermission(session, organizationId, 'members.manage');
      const selected = identifier(membershipId);
      const target = this.store.membershipById(selected);
      const role = target ? this.store.role(target.role_id) : null;
      if (!target || target.organization_id !== organizationId || !role) throw new AccessError('member_not_found', 404);
      if (target.user_id === session.user.id) throw new AccessError('self_removal_forbidden', 409);
      if (role.permissions.some(permission => !actor.permissions.includes(permission))) throw new AccessError('permission_escalation_forbidden', 403);
      if (role.key === 'owner' && this.store.activeOwnerCount(organizationId) <= 1) {
        throw new AccessError('last_owner_protected', 409);
      }
      this.store.removeMembership(selected);
      this.audit({ actorUserId: session.user.id, organizationId, action: 'membership.remove', targetType: 'membership', targetId: selected });
    });
  }
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_INVITATION_TTL_MS,
  AccessControlService,
  opaqueToken,
  tokenHash,
  maskedEmail,
};
