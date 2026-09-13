'use strict';

const { INSTALLATION_IDENTIFIER_RE } = require('../../../shared/contracts/src');

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function createAccessRuntimeAgentAuthorityCatalog({ store } = {}) {
  if (!store || typeof store.activeRuntimeAgentAuthority !== 'function'
      || typeof store.activeRuntimeAgentAuthorityCount !== 'function') fail();

  return Object.freeze({
    resolve(runtimeKey) {
      if (typeof runtimeKey !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(runtimeKey)) return null;
      const authority = store.activeRuntimeAgentAuthority(runtimeKey);
      if (!authority || authority.runtimeKey !== runtimeKey || !/^[a-f0-9]{64}$/.test(authority.tokenHash)
          || !Number.isSafeInteger(authority.generation) || authority.generation < 1) return null;
      return Object.freeze({ digest: authority.tokenHash, generation: authority.generation });
    },

    count() {
      const value = store.activeRuntimeAgentAuthorityCount();
      if (!Number.isSafeInteger(value) || value < 0) fail();
      return value;
    },
  });
}

module.exports = { createAccessRuntimeAgentAuthorityCatalog };
