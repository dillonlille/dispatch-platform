'use strict';

const { defaultPaths } = require('./paths');
const { CredentialVault } = require('./vault');
const { AttemptGuard } = require('./attempt-guard');

function main() {
  process.umask(0o077);
  let vault;
  try {
    const paths = defaultPaths();
    vault = new CredentialVault(paths, { readOnly: true });
    new AttemptGuard(paths.attempts, { readOnly: true });
    const result = vault.verify();
    process.stdout.write(`${JSON.stringify({ ok: result.verified, status: result.verified ? 'verified' : 'failed', ...result, attemptState: 'verified' })}\n`);
    return result.verified ? 0 : 1;
  } catch {
    process.stdout.write('{"ok":false,"status":"verification_failed"}\n');
    return 1;
  } finally {
    vault?.close();
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
