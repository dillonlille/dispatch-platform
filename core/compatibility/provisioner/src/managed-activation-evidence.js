'use strict';

const {
  createLocalPaycomActivationEvidencePort,
} = require('../../../plugins/paycom/backend/adapters/activation-evidence');

function createManagedPaycomActivationEvidenceVerifier(options) {
  return createLocalPaycomActivationEvidencePort(options);
}

module.exports = { createManagedPaycomActivationEvidenceVerifier };
