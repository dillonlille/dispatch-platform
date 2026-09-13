'use strict';
const { validateRequest, result, failure } = require('../src/protocol');
function createTestTransport(handlers = {}) {
  const requests = [];
  return { requests, async request(value, options) {
    const request = validateRequest(value); requests.push(request);
    const handle = Object.hasOwn(handlers, request.operation) ? handlers[request.operation] : null;
    return handle ? result(await handle(request.input, options)) : failure('capability_unavailable');
  } };
}
module.exports = { createTestTransport };
