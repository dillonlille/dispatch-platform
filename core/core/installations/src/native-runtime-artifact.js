'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releaseDescriptor } = require('./native-deployment');

function run(args) {
  const result = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, "./native-runtime-archive.py"), ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 300_000, maxBuffer: 4096,
  });
  if (result.error || result.status !== 0) throw Object.assign(Error('runtime_identity_mismatch'), { code: 'runtime_identity_mismatch' });
}
function unpackNativeRuntime(archive, root, value) {
  const release = releaseDescriptor(value);
  run(['unpack', archive, root, release.embeddedManifestSha256, release.sourceCommit, release.artifactSha256]);
}
function verifyNativeRuntime(root, value) {
  const release = releaseDescriptor(value);
  run(['verify', root, release.embeddedManifestSha256, release.sourceCommit]);
  return true;
}
module.exports = { unpackNativeRuntime, verifyNativeRuntime };
