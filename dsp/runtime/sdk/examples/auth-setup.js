'use strict';

const { createLocalDispatchClient } = require('../src');

async function inspectAuthSetup(dispatch = createLocalDispatchClient()) {
  return dispatch.workflows.authSetup.prepare();
}

async function executeAuthSetup(dispatch, preparation, {
  credentialAction = preparation.data.defaults.credentialAction,
  testAuthentication = preparation.data.defaults.testAuthentication,
  events = { emit() {} },
  signal = null,
} = {}) {
  if (!preparation?.ok) return preparation;
  return dispatch.workflows.authSetup.run({
    provider: preparation.data.target.provider,
    profile: preparation.data.target.profile,
    credentialAction,
    startBroker: preparation.data.defaults.startBroker,
    testAuthentication,
  }, { events, signal });
}

if (require.main === module) {
  inspectAuthSetup().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }).catch(() => { process.exitCode = 1; });
}

module.exports = { inspectAuthSetup, executeAuthSetup };
