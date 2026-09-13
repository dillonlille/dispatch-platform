'use strict';

const path = require('node:path');
const { managedInstallationContext } = require('../../core/accounts/src/installation-authority');
const { createAccessRuntimeAgentAuthorityCatalog } = require('../../core/accounts/src/runtime-agent-authority');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { inspectDsp } = require('../storage/storage');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { fail } = require('./operations');

const BACKEND = 'directory_service_v1';
const ACTIVE_STATES = ['provisioning', 'waiting_for_owner', 'waiting_for_provider_auth', 'verifying', 'ready'];

function directoryAccessAuthority({ paths, store, journal, clock = Date.now }) {
  const access = createAccessRuntimeAgentAuthorityCatalog({ store });
  function context(id) {
    validateDspId(id);
    const row = store.db.prepare('SELECT organization_id,backend FROM installations WHERE runtime_key=?').get(id);
    if (!row || row.backend !== BACKEND) fail('directory_identity_mismatch');
    return managedInstallationContext(store, row.organization_id, { backend: BACKEND });
  }
  function permitted(current) {
    return ACTIVE_STATES.includes(current.installation.status)
      && ['pending_owner', 'setup_required', 'active'].includes(current.organization.status);
  }
  function publishAuthority(record) {
    const dsp = inspectDsp(paths, record.id);
    if (dsp.creationId !== record.creationId || record.desiredState !== 'running') fail('directory_identity_mismatch');
    store.transaction(() => {
      const current = context(record.id);
      if (!permitted(current)) fail('directory_access_changed');
      // Persist only immutable identity here. Mutable business settings remain
      // in Core, so completing owner setup cannot leave a stale duplicate.
      const file = path.join(dsp.root, 'config/installation.json');
      const binding = { version: 1, organizationId: current.organization.id, runtimeKey: record.id };
      const prior = privateJson(file, process.geteuid(), true);
      if (prior && JSON.stringify(prior) !== JSON.stringify(binding)) fail('directory_identity_mismatch');
      if (!prior) atomic(file, binding);
      store.recordRuntimeAgentAuthority({ organizationId: current.organization.id, runtimeKey: record.id,
        tokenHash: record.tokenHash, timestamp: clock() });
    });
  }
  function resolve(id) {
    try {
      if (!permitted(context(id))) return null;
      const local = journal.authorityCatalog().resolve(id), core = access.resolve(id);
      return local && core && local.digest === core.digest ? core : null;
    } catch { return null; }
  }
  function select(record) {
    try { const current = context(record.id); return permitted(current) && current.installation.status !== 'provisioning'; }
    catch { return false; }
  }
  const networkPermitted = id => {
    try { const current = context(id); return current.organization.status === 'active'
      && ['ready', 'waiting_for_provider_auth'].includes(current.installation.status)
      && !store.db.prepare('SELECT 1 FROM diagnostic_dsps WHERE organization_id=?').get(current.organization.id); }
    catch { return false; }
  };
  return { context, publishAuthority, select, networkPermitted,
    authorityCatalog: { resolve, count: () => journal.all().filter(record => resolve(record.id) !== null).length } };
}

module.exports = { BACKEND, ACTIVE_STATES, directoryAccessAuthority };
