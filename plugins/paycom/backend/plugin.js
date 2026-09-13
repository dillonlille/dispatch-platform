'use strict';

// The runtime owns storage, authorization and worker coordination. Paycom only
// contributes its own lifecycle behavior and existing public workforce adapter.
function createPlugin({ configuration, client }) {
  const setup = require('./runtime/setup')
    .createContainerPaycomSetup(configuration, client);
  async function invoke(action, value) {
    const input = require('dispatch-protocol/gateway/protocol').validateActionInput(action, value);
    if (action.startsWith('sync.') && input.id !== 'paycom-main-workforce') throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
    if (action === 'workforce.day') return client.workforce.day(input.query);
    if (action === 'workforce.employees') return client.workforce.employees(input.query);
    if (action === 'workforce.employee') return client.workforce.employee(input.code);
    if (action === 'sync.status') return client.sync.status(input.id);
    if (action === 'sync.run_now') return client.sync.runNow(input.id, input.options);
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
  // The host gates requests, stops schedules and drains cancelled collectors.
  // Installation changes must never lock/unlock the credential profile: doing
  // so would replace or clear an independent provider verification guard.
  return { setup, invoke, busy: setup.busy };
}
function createAuthAdapters() {
  return { paycom: require('./auth/adapter').paycomAdapter };
}

function createClientPorts({ paths, collectionPort }) {
  return {
    paycom: new (require('./adapters/publication').LocalPaycomPublicationPort)({ database: paths.paycom.database }),
    workforce: new (require('./adapters/workforce').LocalPaycomWorkforcePort)({ database: paths.paycom.database,
      ...(collectionPort ? { timezone: () => collectionPort.source('paycom-main').config.timezone } : {}) }),
  };
}

function publish({ paths, directory, timezone }) {
  return require('./adapters/published-job').publish({ database: paths.paycom.database,
    publishedDatabase: require('node:path').join(directory, 'paycom.sqlite3'), timezone });
}

module.exports = { createPlugin, createAuthAdapters, createClientPorts, publish };
