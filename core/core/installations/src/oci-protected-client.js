'use strict';

const { spawnSync } = require('node:child_process');
const { createOciHostHelperClient } = require('./oci-host-helper-client');
const { ISSUER_COMMAND } = require('./oci-host-issuer');

// This client runs as the trusted Access Control Unix identity. Only the
// separate host caller has sudo permission for the execution helper.
function createProtectedOciHostClient({ dispatchRequest }) {
  if (typeof dispatchRequest !== 'function') throw new TypeError('runtime_boundary_violation');
  return createOciHostHelperClient({ requestPort: request => dispatchRequest(request, lease => {
    const input = `${JSON.stringify({ version: 1, lease, request })}\n`;
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('runtime_boundary_violation');
    const result = spawnSync('/usr/bin/sudo', ['-n', ISSUER_COMMAND], {
      input, encoding: 'utf8', timeout: 650_000, maxBuffer: 256 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
    let response;
    if (!result.error && !result.signal && typeof result.stdout === 'string'
        && result.stdout.endsWith('\n') && !result.stdout.slice(0, -1).includes('\n')) {
      try { response = JSON.parse(result.stdout); } catch {}
    }
    if (result.status !== 0 || !response?.ok || Object.keys(response).sort().join(',') !== 'ok,result') {
      const code = response?.status || 'service_installation_failed';
      throw Object.assign(new Error(code), { code, hostStep: response?.step });
    }
    return response.result;
  }) });
}
module.exports = { createProtectedOciHostClient };
