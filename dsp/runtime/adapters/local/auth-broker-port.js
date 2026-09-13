'use strict';

const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { defaultPaths } = require('../../auth-broker/src/paths');

class LocalAuthBrokerPort {
  #socketPath;
  #request;

  constructor({ socketPath = defaultPaths().socket, requestImpl = request } = {}) {
    this.#socketPath = socketPath;
    this.#request = requestImpl;
  }

  request(payload, options = {}) { return this.#request(this.#socketPath, payload, options); }
}

module.exports = { LocalAuthBrokerPort };
