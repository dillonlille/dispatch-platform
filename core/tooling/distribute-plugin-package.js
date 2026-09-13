#!/usr/bin/env node
'use strict';
const { loadPlatformPaths } = require('../shared/paths/platform-paths');
const { distributePackage } = require('../host/plugins/distribution');
async function main() {
  const [config, directory, digest, ...extra] = process.argv.slice(2);
  if (!config || !directory || !/^[a-f0-9]{64}$/.test(digest || '') || extra.length) throw new Error('usage: distribute-plugin-package <private-platform-config> <built-package-directory> <reviewed-sha256>');
  const receipt = await distributePackage(loadPlatformPaths(config), { directory, digest });
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { main };
