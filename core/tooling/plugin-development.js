'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { generateContracts } = require('./plugin-contracts');
const SOURCE = path.resolve(__dirname, '..');

async function prepareDevelopment(pluginRoot, buildRoot = path.resolve(SOURCE, '../../build')) {
  pluginRoot = fs.realpathSync(pluginRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'dispatch-plugin.json'), 'utf8'));
  require('../shared/plugin-sdk/catalog').validateManifest(manifest);
  generateContracts(pluginRoot, { check: true });
  fs.mkdirSync(buildRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(buildRoot, `plugin-${manifest.id}-`));
  fs.chmodSync(workspace, 0o700);
  const artifact = path.join(workspace, 'package');
  const { buildInstalledPlugin } = await import('./build-installed-plugin.mjs');
  const receipt = await buildInstalledPlugin({ id: manifest.id, pluginRoot, output: artifact });
  // A fresh code copy gives the development service its own immutable catalog.
  // It never changes the live catalog or opens real platform/DSP configuration.
  fs.cpSync(SOURCE, path.join(workspace, 'live'), { recursive: true, filter: file =>
    !path.relative(SOURCE, file).split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
  // Core reads declarations only. Plugin behavior runs from the sealed package.
  const destination = path.join(workspace, 'live/plugins', manifest.id);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, 'dispatch-plugin.json'), path.join(destination, 'dispatch-plugin.json'));
  const packages = require('./platform-packages');
  const bundle = path.join(workspace, 'platform-packages');
  packages.buildPlatformPackages(bundle);
  packages.installPlatformPackages(bundle, path.join(workspace, 'live/node_modules'));
  for (const name of ['local', 'dsps', 'dev', 'worktrees']) fs.mkdirSync(path.join(workspace, name), { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'development.json'), JSON.stringify({ version: 1, pluginId: manifest.id, digest: receipt.digest }), { mode: 0o600 });
  return { workspace, receipt };
}
async function startDevelopment(workspace) {
  const child = fork(path.join(workspace, 'live/tooling/plugin-development-service.js'), [], {
    cwd: workspace, env: { PATH: process.env.PATH, DISPATCH_PLUGIN_DEVELOPMENT: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: ['--no-warnings'],
  });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4000); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
  let ready;
  try { ready = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('plugin_development_failed: ' + diagnostic); })]); }
  finally { clearTimeout(timeout); }
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
    try { await exited; } finally { clearTimeout(timer); }
  };
  return { ...ready, workspace, child, close };
}
module.exports = { prepareDevelopment, startDevelopment };
