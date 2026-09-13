'use strict';

const { prepareAuthSetup } = require('../../application/auth/prepare-auth-setup');
const { runSetupAuth } = require('../../application/auth/setup-auth');
const { AuthClient } = require('../../sdk/src/auth-client');
const { LocalAuthBrokerPort } = require('./auth-broker-port');
const { LocalAuthSetupPort } = require('./auth-setup-port');
const { LocalAuthBrokerServicePort } = require('./auth-broker-service-port');
const { LocalCredentialIngress } = require('./credential-ingress');

class LocalAuthSetupWorkflowPort {
  #setup;
  #ingress;
  #service;
  #authentication;

  constructor({
    setup = new LocalAuthSetupPort(),
    ingress = new LocalCredentialIngress(),
    service = new LocalAuthBrokerServicePort(),
    authentication = new AuthClient({ port: new LocalAuthBrokerPort() }),
  } = {}) {
    this.#setup = setup;
    this.#ingress = ingress;
    this.#service = service;
    this.#authentication = authentication;
  }

  prepare(input = {}) {
    return prepareAuthSetup({ setup: this.#setup, service: this.#service, ingress: this.#ingress }, input);
  }

  run(input = {}, { events, signal = null } = {}) {
    return runSetupAuth({
      setup: this.#setup,
      ingress: this.#ingress,
      service: this.#service,
      authentication: this.#authentication,
      events,
      signal,
    }, input);
  }
}

module.exports = { LocalAuthSetupWorkflowPort };
