'use strict';
// Run by the local root operator as the existing Core service user. Credentials
// travel through protected pipes, never arguments or the public test report.
const fs = require('node:fs');
const { AccessStore, AccessControlService } = require('../../../accounts/src');
async function main(input) {
  const store = new AccessStore({ databaseRoot: input.localRoot + '/data/access-control', database: input.localRoot + '/data/access-control/access-control.sqlite3' });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: 'native_service_v1', sessionTtlMs: 60 * 60 * 1000 });
  const sessionView = value => ({ token: value.token, csrf: value.session.csrfToken });
  try {
    if (input.action === 'session') {
      const owner = store.db.prepare("SELECT id FROM users WHERE platform_role='owner' AND status='active' ORDER BY id LIMIT 1").get();
      if (!owner) throw Error('platform_owner_required');
      return sessionView(access.createSession(owner.id));
    }
    const session = access.requireSession(input.session.token);
    if (input.action === 'logout') { access.signOut(session); return {}; }
    if (input.action === 'destroy') {
      access.requirePlatform(session, 'platform.installations.manage');
      if (!/^live_[a-f0-9]{32}$/.test(input.runId) || ![0, 1].includes(input.index)) throw Error('invalid_test_request');
      const created = store.db.prepare("SELECT organization_id FROM platform_mutation_requests WHERE actor_user_id=? AND action='organization.create' AND idempotency_key=?")
        .get(session.user.id, `${input.runId}:create:${input.index}`);
      const profile = created && store.db.prepare('SELECT owner_email FROM organization_profiles WHERE organization_id=?').get(created.organization_id);
      if (!created || created.organization_id !== input.organizationId || profile?.owner_email !== `${input.runId}-${input.index}@dispatch-test.invalid`
          || store.installationBackend(created.organization_id) !== 'native_service_v1') throw Error('invalid_test_request');
      // This protected local operator already has host authority. It can retire
      // only its own recorded fixtures; browser deletion always needs a password.
      return require('../../../accounts/src/installation-lifecycle').createAccessInstallationLifecycleAuthority({
        store, organizationId: created.organization_id, authorityScope: 'platform_removal', actorUserId: session.user.id, destructionEnabled: true,
      }).request({ operation: 'destroy', expectedRevision: input.expectedRevision, idempotencyKey: `${input.runId}:delete:${input.index}` });
    }
    if (input.action !== 'create' || !/^live_[a-f0-9]{32}$/.test(input.runId) || ![0, 1].includes(input.index)) throw Error('invalid_test_request');
    const email = `${input.runId}-${input.index}@dispatch-test.invalid`;
    const result = access.createOrganization(session, { ownerEmail: email, idempotencyKey: `${input.runId}:create:${input.index}` });
    // A retry must never reset an existing account or recover somebody's login.
    if (!result.token) throw Error('test_creation_already_exists');
    return { organizationId: result.organization.id, invitationToken: result.token, email };
  } finally { store.close(); }
}
if (require.main === module) main(JSON.parse(fs.readFileSync(0, 'utf8'))).then(v => process.stdout.write(JSON.stringify(v))).catch(e => {
  process.stderr.write(JSON.stringify({ code: e.code || e.message })); process.exitCode = 1;
});
module.exports = { main };
