'use strict';

const path = require('node:path');
const { createImmutableArtifact } = require('./immutable-artifact');

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const HOST_HELPER_ARTIFACT_FILES = Object.freeze([
  'core/installations/bin/dispatch-oci-host-helper',
  'core/installations/bin/dispatch-oci-host-issuer',
  'core/installations/bin/dispatch-oci-tenant-backup-helper',
  'core/installations/src/oci-host-helper.js',
  'core/installations/src/oci-helper-input.js',
  'core/installations/src/oci-host-authority.js',
  'core/installations/src/oci-host-issuer.js',
  'core/installations/src/oci-host-artifact.js',
  'core/installations/src/oci-host-account-registry.js',
  'core/installations/src/oci-host-executor.js',
  'core/installations/src/oci-deployment.js',
  'core/installations/src/native-deployment.js',
  'core/installations/src/native-runtime-artifact.js',
  'core/installations/src/native-runtime-archive.py',
  'core/installations/src/backups.js',
  'core/runtime-host-identity.js',
  'shared/paths/runtime-paths.js',
  'shared/contracts/src/input.js',
  'shared/contracts/src/paycom-setup.js',
  'shared/contracts/src/connections.js',
  'shared/contracts/src/installation.js',
  'shared/contracts/src/publication-baseline.js',
  'shared/contracts/src/result.js',
  'shared/contracts/src/sync.js',
  'shared/contracts/src/workforce.js',
  'shared/agent/framing.js',
  'shared/agent/protocol.js',
  'shared/gateway/protocol.js',
  'shared/gateway/strict-json.js',
]);
const EXECUTABLES = new Set([
  'core/installations/bin/dispatch-oci-host-helper',
  'core/installations/bin/dispatch-oci-host-issuer',
  'core/installations/bin/dispatch-oci-tenant-backup-helper',
]);

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' });
  const receipt = createImmutableArtifact({
    projectRoot: PROJECT_ROOT, target: argv[0], sourceFiles: HOST_HELPER_ARTIFACT_FILES, executables: EXECUTABLES, includeModes: true,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, status: 'host_helper_artifact_created', ...receipt })}\n`);
}

if (require.main === module) {
  try { main(); } catch { process.stderr.write('host helper artifact creation failed\n'); process.exitCode = 1; }
}
module.exports = { HOST_HELPER_ARTIFACT_FILES, main };
