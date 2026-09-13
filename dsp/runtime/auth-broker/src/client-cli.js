'use strict';

const { defaultPaths } = require('./paths');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');

async function main(argv = process.argv.slice(2)) {
  const [action, profile, ...rest] = argv;
  if (rest.length || !['health', 'providers', 'list', 'status', 'lock', 'unlock', 'test-auth-profile', 'inspect-auth-profile', 'profile-readiness'].includes(action)
      || ['status', 'lock', 'unlock', 'test-auth-profile', 'inspect-auth-profile', 'profile-readiness'].includes(action) !== Boolean(profile)) {
    process.stdout.write('{"ok":false,"status":"invalid_request"}\n');
    return 2;
  }
  try {
    const result = await request(
      defaultPaths().socket,
      profile ? { action, profile } : { action },
      ['test-auth-profile', 'inspect-auth-profile'].includes(action) ? { timeoutMs: 140_000 } : {},
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch {
    process.stdout.write('{"ok":false,"status":"broker_unavailable"}\n');
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main };
