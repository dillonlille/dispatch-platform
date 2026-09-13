'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inventory, read, directory } = require('dispatch-protocol/plugin-sdk/package-files');
const { validatePackage, digest } = require('dispatch-protocol/plugin-sdk/package');
const { MAX_MANIFEST_BYTES } = require('dispatch-protocol/plugin-sdk/catalog');

// Seals an already-built, self-contained package directory. No DSP code or
// dependency lifecycle scripts are executed by this packaging step.
function sealPackage(root) {
  directory(root);
  const plugin = JSON.parse(read(root, 'dispatch-plugin.json', MAX_MANIFEST_BYTES));
  const files = inventory(root).map(relative => {
    const bytes = read(root, relative);
    const executable = Boolean(fs.statSync(path.join(root, relative)).mode & 0o111);
    return { path: relative, size: bytes.length, sha256: digest(bytes), mode: executable ? 0o555 : 0o444 };
  });
  const manifest = validatePackage({ schemaVersion: 1, sdkApiVersion: 1, plugin, files });
  const bytes = JSON.stringify(manifest) + '\n';
  fs.writeFileSync(path.join(root, 'package-manifest.json'), bytes, { flag: 'wx', mode: 0o444 });
  return { digest: digest(bytes), files: files.length, bytes: files.reduce((sum, item) => sum + item.size, 0) };
}
if (require.main === module) {
  try { console.log(JSON.stringify(sealPackage(path.resolve(process.argv[2])))); }
  catch { console.error('plugin_package_build_failed'); process.exitCode = 1; }
}
module.exports = { sealPackage };
