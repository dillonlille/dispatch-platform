'use strict';
const { createPrivateTransport } = require('./index');
const { unwrap, boundedJson } = require('../src/protocol');
// Available only to the trusted DSP framework. Ordinary plugin namespaces
// expose sdk.sock instead, with immutable plugin/revision/job identity.
function createFrameworkClient({ socketPath = '/run/dispatch-agent/backend.sock' } = {}) {
  const transport = createPrivateTransport({ socketPath, timeoutMs: 3660000 });
  return Object.freeze({ async request(operation, input, options) {
    return unwrap(await transport.request({ schemaVersion: 1, operation, input: boundedJson(input) }, options));
  } });
}
module.exports = { createFrameworkClient };
