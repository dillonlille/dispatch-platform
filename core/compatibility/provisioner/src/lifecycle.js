'use strict';
const { createManagedInstallationLifecycle: createLifecycle } = require('../../../core/installations/src/lifecycle.js');
const { createManagedPaycomActivationComposition } = require('./managed-activation-runtime');
function createManagedInstallationLifecycle(options) {
  return createLifecycle({ ...options, activationRuntimeFactory: options.activationRuntimeFactory || (context => createManagedPaycomActivationComposition({
    manifest: context.manifest, manifestAuthority: context.manifestAuthority, installationsRoot: options.installationsRoot,
    unitRoot: options.unitRoot, supervisor: options.supervisor, projectRoot: context.projectRoot,
    ...(options.runtimeAgentHubSocket === undefined ? {} : { runtimeAgentHubSocket: options.runtimeAgentHubSocket }),
  })) });
}
module.exports = { createManagedInstallationLifecycle };
