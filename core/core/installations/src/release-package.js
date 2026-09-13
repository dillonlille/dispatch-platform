'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashFileSync } = require('./release-delivery-files');
function archive(args) {
  const result = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, "./release-package.py"), ...args], {
    encoding: 'utf8', timeout: 300_000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  require('./release-build-space').checkArchiveResult(result, 'release_package_invalid');
  return result.stdout;
}
function pack(root, output, kind, commit = '-') {
  const { unpackedSize } = JSON.parse(archive(['pack', root, output, kind, commit]));
  return { name: path.basename(output), size: fs.statSync(output).size, unpackedSize, sha256: hashFileSync(output) };
}
function unpack(file, root, kind, commit, sha256, unpackedSize) { archive(['unpack', file, root, kind, commit, sha256, ...(unpackedSize === undefined ? [] : [String(unpackedSize)])]); }
// The v2 runtime identity binds both independently checksummed packages. The
// existing runtime catalog continues to carry a single immutable identity.
function runtimeIdentity(assets) {
  return require('./release-delivery-contract').sha(JSON.stringify({ app: assets.app.sha256, dependencies: assets.dependencies.sha256 }));
}
function preparePackages(directory, manifest) {
  const { removeStage, seal } = require('./release-delivery-install');
  const stage = path.join(directory, 'packages'); removeStage(stage); fs.mkdirSync(stage, { mode: 0o700 });
  try {
  const app = path.join(stage, 'app'), dependencies = path.join(stage, 'dependencies');
  unpack(path.join(directory, manifest.assets.app.name), app, 'app', manifest.sourceCommit, manifest.assets.app.sha256, manifest.assets.app.unpackedSize);
  unpack(path.join(directory, manifest.assets.dependencies.name), dependencies, 'dependencies', '-', manifest.assets.dependencies.sha256, manifest.assets.dependencies.unpackedSize);
  const runtime = path.join(app, 'runtime');
  fs.chmodSync(runtime, 0o700);
  fs.renameSync(path.join(dependencies, 'dependencies'), path.join(runtime, 'dependencies'));
  seal(runtime);
  require('./native-runtime-artifact').verifyNativeRuntime(runtime, manifest.runtime);
  const { collect } = require('./release-delivery-build');
  const { bundle } = require('./release-delivery-contract');
  const read = kind => {
    const files = [];
    for (const name of fs.readdirSync(path.join(app, kind)).sort()) collect(path.join(app, kind), name, files);
    return bundle({ schemaVersion: 1, kind, sourceCommit: manifest.sourceCommit, files }, kind, manifest.sourceCommit);
  };
  return { core: read('core'), bridge: read('bridge'), runtime, stage };
  } catch (error) { removeStage(stage); throw error; }
}
module.exports = { pack, unpack, preparePackages, runtimeIdentity };
