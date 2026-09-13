'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {sha} = require('./release-delivery-contract');
const {removeStage} = require('./release-delivery-install');

const ASSETS = ['frontend.js', 'styles.css'];

// Build only committed source in disposable storage. Never trust a checkout's
// ignored bundles or node_modules as inputs to an immutable release.
function buildFrontend(projectRoot, commit, outputParent, {run = spawnSync} = {}) {
  const scratch = fs.mkdtempSync(path.join(outputParent, 'frontend-build-'));
  function command(executable, args, options = {}) {
    const result = run(executable, args, {cwd: projectRoot, encoding: 'utf8',
      timeout: 600_000, maxBuffer: 32 * 1024 * 1024, ...options});
    if (result.error || result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr.toString().slice(-8192));
      throw Error('release_frontend_build_failed:' + path.basename(executable));
    }
    return result.stdout;
  }
  try {
    const archive = command('/usr/bin/git', ['archive', commit, 'dashboard', 'plugins'], {encoding: null});
    command('/usr/bin/tar', ['-xf', '-', '-C', scratch], {input: archive});
    const dashboard = path.join(scratch, 'dashboard');
    command('npm', ['ci', '--no-audit', '--no-fund'], {cwd: dashboard});
    command('npm', ['exec', '--', 'tsc', '--noEmit'], {cwd: dashboard});
    command('npm', ['exec', '--', 'vite', 'build'], {cwd: dashboard});
    return ASSETS.map(name => {
      const file = path.join(dashboard, 'public/assets', name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size) throw Error('invalid_frontend_asset');
      const data = fs.readFileSync(file);
      return {path: `code/dashboard/public/assets/${name}`, mode: '444', sha256: sha(data), data: data.toString('base64')};
    });
  } finally {
    removeStage(scratch);
  }
}

module.exports = {ASSETS, buildFrontend};
