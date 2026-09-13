'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildNativeRuntime } = require('dispatch-core/core/installations/src/native-runtime-build.js');
const { hashFileSync } = require('dispatch-core/core/installations/src/release-delivery-files.js');
const { removeStage } = require('dispatch-core/core/installations/src/release-delivery-install.js');
const root = path.resolve(__dirname, "../../.."), output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('fixture_output_invalid');
fs.mkdirSync(output, { mode: 0o700 });
const sourceCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const result = buildNativeRuntime({ projectRoot: root, archive: path.join(output, 'runtime.tar.gz'), sourceCommit });
const bridge = path.join(output, 'bridge');
try {
  require('dispatch-core/core/installations/src/create-bridge-artifact.js').main([bridge]);
  fs.writeFileSync(path.join(output, 'descriptor.json'), JSON.stringify({ version: 1, backend: 'native_service_v1',
    releaseId: 'dispatch_native_fixture', channel: 'fixture', sourceCommit, platform: 'linux/amd64',
    runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1, ...result,
    bridgeManifestSha256: hashFileSync(path.join(bridge, 'manifest.json')) }) + '\n', { mode: 0o600 });
} finally { removeStage(bridge); }
