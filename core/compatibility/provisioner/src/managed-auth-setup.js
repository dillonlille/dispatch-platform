'use strict';

const crypto = require('node:crypto');
const { failure } = require('dispatch-protocol/contracts/src');
const {
  PROJECT_ROOT,
  managedInstallationRuntimeEnvironment,
  resolveManagedInstallationRuntimePaths,
} = require('dispatch-protocol/paths/runtime-paths');
const { prepareAuthSetup } = require('../../../runtime/application/auth/prepare-auth-setup');
const { runSetupAuth, RecordingEventSink } = require('../../../runtime/application/auth/setup-auth');
const { AuthClient } = require('../../../runtime/sdk/src/auth-client');
const { LocalAuthBrokerPort } = require('../../../runtime/adapters/local/auth-broker-port');
const { LocalAuthSetupPort } = require('../../../runtime/adapters/local/auth-setup-port');
const { LocalCredentialIngress } = require('../../../runtime/adapters/local/credential-ingress');
const { createInstallationLayoutManager } = require('../../../core/installations/src/layout.js');
const { createInstallationServiceManager } = require('../../../core/installations/src/services.js');

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

class ManagedRuntimeServicePort {
  constructor({ plan, supervisor, authority }) {
    if (!plan || !supervisor || !['snapshot', 'start', 'stop', 'health'].every(method => typeof supervisor[method] === 'function')
        || !authority || typeof authority.guard !== 'function') fail('runtime_boundary_violation');
    this.plan = plan;
    this.supervisor = supervisor;
    this.authority = authority;
  }

  state() {
    const values = this.supervisor.snapshot(this.plan);
    if (!Array.isArray(values) || values.length !== this.plan.units.length) fail('broker_state_unknown');
    const active = values.filter(value => value.active).length;
    if (active === values.length) return 'ready';
    if (active === 0) return 'stopped';
    fail('broker_state_unknown');
  }

  async status() {
    const status = this.state();
    if (status === 'ready') this.supervisor.health(this.plan);
    return { status, managed: true };
  }

  async stop() {
    if (this.state() === 'stopped') return { status: 'stopped', managed: true, stopped: false };
    this.supervisor.stop(this.plan, mutation => this.authority.guard(mutation));
    if (this.state() !== 'stopped') fail('auth_broker_stop_failed');
    return { status: 'stopped', managed: true, stopped: true };
  }

  async start() {
    if (this.state() === 'ready') {
      this.supervisor.health(this.plan);
      return { status: 'ready', managed: true, started: false };
    }
    this.supervisor.start(this.plan, mutation => this.authority.guard(mutation));
    this.supervisor.health(this.plan);
    if (this.state() !== 'ready') fail('auth_broker_start_failed');
    return { status: 'ready', managed: true, started: true };
  }
}

function createManagedPaycomAuthSetup(options) {
  const fields = [
    'manifest', 'manifestAuthority', 'authority', 'installationsRoot', 'unitRoot', 'supervisor',
    'projectRoot', 'events', 'runtimeAgentHubSocket',
  ];
  if (!plain(options) || Object.keys(options).some(key => !fields.includes(key))
      || !['manifest', 'manifestAuthority', 'authority', 'installationsRoot', 'unitRoot', 'supervisor']
        .every(key => Object.hasOwn(options, key))) fail('runtime_boundary_violation');
  if (!['peek', 'beginSetup', 'endSetup', 'guard']
    .every(method => typeof options.authority[method] === 'function')) {
    fail('runtime_boundary_violation');
  }
  const boundContext = context => {
    if (!plain(context) || context.installation?.state !== 'waiting_for_provider_auth'
        || JSON.stringify(context.manifest) !== JSON.stringify(options.manifest)
        || JSON.stringify(context.manifestAuthority) !== JSON.stringify(options.manifestAuthority)) {
      fail('runtime_identity_mismatch');
    }
    return context;
  };
  const initialContext = options.authority.peek();
  if (initialContext && typeof initialContext.then === 'function') fail('runtime_boundary_violation');
  boundContext(initialContext);
  const projectRoot = options.projectRoot === undefined ? PROJECT_ROOT : options.projectRoot;
  const layout = createInstallationLayoutManager({ installationsRoot: options.installationsRoot, projectRoot });
  const selectedLayout = layout.derive(options.manifest, options.manifestAuthority);
  const paths = resolveManagedInstallationRuntimePaths(selectedLayout);
  const serviceManager = createInstallationServiceManager({
    unitRoot: options.unitRoot,
    projectRoot,
    ...(options.runtimeAgentHubSocket === undefined ? {} : {
      runtimeAgentHubSocket: options.runtimeAgentHubSocket,
    }),
  });
  const plan = serviceManager.plan(options.manifest, options.manifestAuthority, selectedLayout);
  serviceManager.inspectInstalled(plan);
  const environment = managedInstallationRuntimeEnvironment(selectedLayout);
  const runOptions = { environment };
  const setup = new LocalAuthSetupPort({ paths: paths.auth, runOptions });
  const ingress = new LocalCredentialIngress({ runOptions });
  const guardedSetup = Object.freeze({
    inspect: profile => setup.inspect(profile),
    initialize: () => options.authority.guard(() => setup.initialize()),
    remove: profile => options.authority.guard(() => setup.remove(profile)),
  });
  const guardedIngress = Object.freeze({
    available: () => ingress.available(),
    capture: input => options.authority.guard(() => ingress.capture(input)),
  });
  const service = new ManagedRuntimeServicePort({ plan, supervisor: options.supervisor, authority: options.authority });
  const authentication = new AuthClient({ port: new LocalAuthBrokerPort({ socketPath: paths.auth.socket }) });
  const events = options.events === undefined ? new RecordingEventSink() : options.events;
  if (!events || typeof events.emit !== 'function') fail('runtime_boundary_violation');

  async function prepare() {
    try {
      boundContext(await options.authority.peek());
      return prepareAuthSetup({ setup, service, ingress }, { provider: 'paycom', profile: 'paycom-main' });
    } catch (error) {
      return failure(error?.code === 'installation_operation_in_progress'
        ? 'installation_operation_in_progress' : 'installation_not_ready', { recoverable: true });
    }
  }

  async function run(input) {
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'credentialAction'
        || !['create', 'replace'].includes(input.credentialAction)) {
      return failure('invalid_input');
    }
    let claimed = false;
    let result;
    try {
      boundContext(await options.authority.peek());
      boundContext(await options.authority.beginSetup());
      claimed = true;
      result = await runSetupAuth({
        setup: guardedSetup, ingress: guardedIngress, service, authentication, events,
      }, {
        provider: 'paycom',
        profile: 'paycom-main',
        credentialAction: input.credentialAction === 'create' ? 'enroll' : 'replace',
        startBroker: true,
        testAuthentication: false,
        operationId: `setup_auth_${crypto.randomUUID().replaceAll('-', '')}`,
      });
      if (result.ok) boundContext(await options.authority.peek());
    } catch (error) {
      const code = ['installation_operation_in_progress', 'installation_not_ready', 'runtime_identity_mismatch']
        .includes(error?.code)
        ? error.code : 'setup_auth_failed';
      result = failure(code, { recoverable: code !== 'setup_auth_failed' });
    } finally {
      if (claimed) {
        try { boundContext(await options.authority.endSetup()); }
        catch { result = failure('installation_operation_in_progress', { recoverable: true }); }
      }
    }
    return result;
  }

  return Object.freeze({ prepare, run });
}

module.exports = {
  ManagedRuntimeServicePort,
  createManagedPaycomAuthSetup,
};
