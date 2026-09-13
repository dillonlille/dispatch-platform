'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pinned = require('../runtime-dependencies.json');
function verify({ node = process.execPath, browserRoot = process.env.DISPATCH_BUILD_BROWSER_ROOT || '/opt/google/chrome', run = spawnSync } = {}) {
  const version = executable => {
    const result = run(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    if (result.error || result.status !== 0) throw Error('release_dependency_unavailable');
    return result.stdout.trim();
  };
  if (version(node) !== `v${pinned.node}` || !new RegExp(`^Google Chrome(?: for Testing)? ${pinned.chrome.replaceAll('.', '\\.')}\\s*$`).test(version(path.join(browserRoot, 'chrome')))) throw Error('release_dependency_version_mismatch');
  return { node: pinned.node, chrome: pinned.chrome };
}
module.exports = { verify };
