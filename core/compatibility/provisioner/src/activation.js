'use strict';
const { runManagedPaycomActivation: runActivation } = require('../../../core/installations/src/activation.js');
const { managedPaycomDefinition } = require('./managed-paycom');
function runManagedPaycomActivation(options) {
  return runActivation({ ...options, definitionFactory: context => managedPaycomDefinition(context.manifest, context.manifestAuthority, {
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }), container: options.container === true,
  }) });
}
module.exports = { ...require('../../../core/installations/src/activation.js'), runManagedPaycomActivation };
