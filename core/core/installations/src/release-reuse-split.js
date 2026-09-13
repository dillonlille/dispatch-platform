'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pack, unpack, runtimeIdentity } = require('./release-package');
const { removeStage } = require('./release-delivery-install');

// The caller has verified every asset against the exact-commit CI manifest.
// Only the small application archive changes with release-specific popup copy.
function reuse(directory, output, manifest, popup) {
  const stage = path.join(output, 'reuse-app');
  const asset = manifest.assets.app;
  try {
    unpack(path.join(directory, asset.name), stage, 'app', manifest.sourceCommit, asset.sha256, asset.unpackedSize);
    const popupFile = path.join(stage, 'core/code/dashboard/release-popup.json');
    fs.chmodSync(path.dirname(popupFile), 0o700);
    if (fs.existsSync(popupFile)) fs.unlinkSync(popupFile);
    if (popup) {
      require('../../accounts/src/release-popup').validatePopup(popup, {
        releaseId: popup.releaseId, version: popup.version, sourceCommit: manifest.sourceCommit,
      });
      fs.writeFileSync(popupFile, JSON.stringify(popup) + '\n', { flag: 'wx', mode: 0o444 });
    }
    const assets = {
      app: pack(stage, path.join(output, asset.name), 'app', manifest.sourceCommit),
      dependencies: manifest.assets.dependencies,
    };
    fs.copyFileSync(path.join(directory, assets.dependencies.name), path.join(output, assets.dependencies.name), fs.constants.COPYFILE_EXCL);
    return {
      assets, dependencies: manifest.dependencies,
      artifact: { artifactSha256: runtimeIdentity(assets), embeddedManifestSha256: manifest.runtime.embeddedManifestSha256 },
      bridgeHash: manifest.runtime.bridgeManifestSha256,
    };
  } finally { removeStage(stage); }
}
module.exports = { reuse };
