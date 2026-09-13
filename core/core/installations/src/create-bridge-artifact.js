'use strict';

const path = require('node:path');
const { createImmutableArtifact } = require('./immutable-artifact');

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const BRIDGE_ARTIFACT_FILES = Object.freeze([
  'core/agent-bridge/src/bridge.js',
  'core/agent-bridge/src/forwarding.js',
  'core/agent-bridge/src/service-cli.js',
  'core/runtime-host-identity.js',
  'shared/contracts/src/input.js',
  'shared/contracts/src/paycom-setup.js',
  'shared/contracts/src/connections.js',
  'shared/contracts/src/installation.js',
  'shared/contracts/src/result.js',
  'shared/contracts/src/sync.js',
  'shared/contracts/src/workforce.js',
  'shared/agent/capacity.js',
  'shared/agent/framing.js',
  'shared/agent/protocol.js',
  'shared/gateway/protocol.js',
  'shared/gateway/strict-json.js',
]);

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' });
  const receipt = createImmutableArtifact({
    projectRoot: PROJECT_ROOT, target: argv[0], sourceFiles: BRIDGE_ARTIFACT_FILES,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, status: 'bridge_artifact_created', ...receipt })}\n`);
}

if (require.main === module) {
  try { main(); } catch { process.stderr.write('bridge artifact creation failed\n'); process.exitCode = 1; }
}
module.exports = { BRIDGE_ARTIFACT_FILES, main };
