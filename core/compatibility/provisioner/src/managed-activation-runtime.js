'use strict';
const { PROJECT_ROOT, resolveManagedInstallationRuntimePaths, managedInstallationRuntimeEnvironment } = require('dispatch-protocol/paths/runtime-paths');
const path = require('node:path');
const { serverInstallationManifest } = require('dispatch-protocol/contracts/src');
const { LocalCollectionAdminPort } = require('../../../runtime/adapters/local/collection-admin-port');
const { createRuntimeGatewayDispatchClient } = require('../../../runtime/gateway/src');
const { createManagedRuntimeDispatchClient } = require('../../../runtime/gateway/src/managed-runtime');
const { createManagedPaycomActivationEvidenceVerifier } = require('./managed-activation-evidence');
const shared = require('../../../plugins/paycom/backend/runtime/activation');
const { createManagedPaycomActivationRuntime } = shared;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function createManagedPaycomActivationComposition(options) {
  const optionFields = [
    'manifest', 'manifestAuthority', 'installationsRoot', 'unitRoot', 'supervisor', 'projectRoot',
    'clock', 'delay', 'publicationTimeoutMs', 'publicationPollMs', 'runtimeAgentHubSocket',
  ];
  if (!plain(options) || Object.keys(options).some(key => !optionFields.includes(key))
      || !['manifest', 'manifestAuthority', 'installationsRoot', 'unitRoot', 'supervisor']
        .every(key => Object.hasOwn(options, key))) fail('runtime_boundary_violation');
  const projectRoot = options.projectRoot === undefined ? PROJECT_ROOT : options.projectRoot;
  const manifest = serverInstallationManifest(options.manifest, options.manifestAuthority);
  const { createInstallationLayoutManager } = require('../../../core/installations/src/layout.js');
  const { createInstallationServiceManager } = require('../../../core/installations/src/services.js');
  const layout = createInstallationLayoutManager({ installationsRoot: options.installationsRoot, projectRoot });
  const selectedLayout = layout.derive(manifest, options.manifestAuthority);
  const serviceManager = createInstallationServiceManager({
    unitRoot: options.unitRoot,
    projectRoot,
    ...(options.runtimeAgentHubSocket === undefined ? {} : {
      runtimeAgentHubSocket: options.runtimeAgentHubSocket,
    }),
  });
  const paths = resolveManagedInstallationRuntimePaths(selectedLayout);
  const environment = managedInstallationRuntimeEnvironment(selectedLayout);
  const client = createManagedRuntimeDispatchClient({ paths });
  const collectionAdmin = new LocalCollectionAdminPort({ paths: paths.collection });
  const clock = options.clock === undefined ? Date.now : options.clock;
  const evidenceVerifier = createManagedPaycomActivationEvidenceVerifier({ environment });
  const gateway = createRuntimeGatewayDispatchClient({
    socketPath: path.join(paths.runtimeRoot, 'runtime-gateway.sock'),
    runtimeKey: manifest.runtime.key,
  });
  return createManagedPaycomActivationRuntime({
    manifest,
    manifestAuthority: options.manifestAuthority,
    layout,
    serviceManager,
    supervisor: options.supervisor,
    client,
    collectionAdmin,
    gateway,
    evidenceVerifier,
    projectRoot,
    clock,
    ...(options.delay === undefined ? {} : { delay: options.delay }),
    ...(options.publicationTimeoutMs === undefined ? {} : { publicationTimeoutMs: options.publicationTimeoutMs }),
    ...(options.publicationPollMs === undefined ? {} : { publicationPollMs: options.publicationPollMs }),
  });
}

module.exports = { ...shared, createManagedPaycomActivationComposition };
