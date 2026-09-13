'use strict';

const { AccessError } = require('./validation');
const { managedInstallationContext } = require('./installation-authority');
const { SERVICES, service, credentialsFor, verificationInput, connectionView, connectionList, REASONS } = require('../../../shared/contracts/src/connections');

function createOwnerConnections({ store, access, invoke, clock = Date.now, paycomSetup = null }) {
  const onboarding = require('./onboarding-store').createOnboardingStore(store, clock);
  function context(session) {
    const { organization } = access.requireDspOwner(session);
    const selected = managedInstallationContext(store, organization.id);
    if (organization.status !== 'active' || !['ready', 'waiting_for_provider_auth'].includes(selected.installation.status)
        || store.activeLifecycleJob(organization.id)) {
      throw new AccessError('installation_not_ready', 409);
    }
    return { ...selected, organization };
  }
  function reauthorize(session, previous) {
    const current = context(session);
    if (current.organization.id !== previous.organization.id || current.manifest.runtime.key !== previous.manifest.runtime.key
        || current.installation.revision !== previous.installation.revision) throw new AccessError('installation_not_ready', 409);
  }
  async function call(session, input) {
    const selected = context(session);
    let result;
    try { result = await invoke(selected.manifest.runtime.key, 'connections.manage', input); }
    catch { throw new AccessError('auth_unavailable', 503); }
    reauthorize(session, selected);
    if (!result?.ok) {
      const code = REASONS.includes(result?.status) || result?.status === 'profile_not_configured' ? result.status : 'auth_unavailable';
      throw new AccessError(code, code === 'auth_unavailable' ? 503 : 409);
    }
    try {
      if (input.command === 'list') {
        if (result.status !== 'found') throw new Error();
        const listed = connectionList(result.data);
        return { items: listed.items.filter(item => {
          const owner = require('../../../shared/plugin-sdk/catalog').catalog().find(plugin => plugin.services.includes(item.service));
          return !owner || require('./plugins').available(store, selected.organization.id, owner.id);
        }).map(item => {
          // A confirmed save can outlive a lost check acknowledgement. Its
          // durable onboarding request still owns the pending verification.
          if (item.service === 'paycom' && item.state === 'not_verified') {
            const pending = onboarding.latest(selected.organization.id);
            if (['queued', 'running'].includes(pending?.status)) return { ...item, state: 'checking', reason: null };
            if (pending?.status === 'failed') return { ...item, state: 'temporarily_unavailable', reason: 'auth_unavailable' };
          }
          return item;
        }) };
      }
      if (result.status !== 'accepted') throw new Error();
      const view = connectionView(result.data);
      if (view.service !== input.service) throw new Error();
      access.audit({ actorUserId: session.user.id, organizationId: selected.organization.id,
        action: `connection.${input.command}`, targetType: 'connection', targetId: input.service });
      return view;
    } catch { throw new AccessError('auth_unavailable', 503); }
  }
  return {
    list: session => call(session, { command: 'list' }),
    async change(session, id, command, body) {
      const selected = context(session);
      if (store.runningActivationJob(selected.organization.id)) throw new AccessError('session_busy', 409);
      try {
        service(id);
        const owner = require('../../../shared/plugin-sdk/catalog').catalog().find(plugin => plugin.services.includes(id));
        if (owner) require('./plugins').requirePlugin(access, session, owner.id);
        const keys = command === 'save' ? ['credentials'] : command === 'verify' ? ['code', 'verificationId'] : [];
        if (!body || Object.getPrototypeOf(body) !== Object.prototype
            || Object.keys(body).sort().join(',') !== keys.join(',') || !['save', 'test', 'disconnect', 'verify'].includes(command)) {
          throw new AccessError('invalid_input', 400);
        }
        const input = { command, service: id, ...(command === 'save'
          ? { credentials: credentialsFor(id, body.credentials), expiresAt: clock() + 30_000 }
          : command === 'verify' ? { ...verificationInput(body), expiresAt: clock() + 30_000 } : {}) };
        if (command === 'verify' && id !== 'cortex') throw new AccessError('invalid_input', 400);
        if (id === 'paycom' && paycomSetup && ['save', 'test'].includes(command)) {
          const setup = await paycomSetup.status(session);
          if (command === 'save' && setup.canSubmit) {
            const current = await call(session, { command: 'list' });
            const configured = current.items.find(item => item.service === id).configured;
            await paycomSetup.submit(session, {
              idempotencyKey: `connections:${require('node:crypto').randomUUID()}`,
              intent: configured ? 'replace' : 'create', credentials: input.credentials,
            });
            const listed = await call(session, { command: 'list' });
            access.audit({ actorUserId: session.user.id, organizationId: selected.organization.id,
              action: 'connection.save', targetType: 'connection', targetId: id });
            return listed.items.find(item => item.service === id);
          }
          if (command === 'test' && setup.canRetry) {
            await paycomSetup.retry(session, {});
            access.audit({ actorUserId: session.user.id, organizationId: selected.organization.id,
              action: 'connection.test', targetType: 'connection', targetId: id });
            return (await call(session, { command: 'list' })).items.find(item => item.service === id);
          }
        }
        return await call(session, input);
      } catch (error) {
        if (error instanceof AccessError) throw error;
        if (error?.code === 'invalid_input') throw new AccessError('invalid_input', 400);
        // Transport or audit failures can occur after persistence. Do not claim
        // the user's input was rejected when the save outcome is uncertain.
        throw new AccessError('auth_unavailable', 503);
      }
    },
    services: Object.values(SERVICES).map(({ id, name, fields }) => ({ id, name, fields })),
  };
}
module.exports = { createOwnerConnections };
