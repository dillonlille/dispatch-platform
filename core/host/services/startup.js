'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { platformPaths } = require('../../shared/paths/platform-paths');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { loadInstallation } = require('./installation');
const { command, privateDirectory, fail } = require('../controller/operations');
const { loadDashboardSettings } = require('../controller/dashboard-settings');

function unitValue(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value)
      || path.resolve(value) !== value || fs.realpathSync(value) !== value) fail('directory_startup_invalid');
  return value;
}

async function preflight(paths) {
  paths = platformPaths(paths.platformRoot);
  const installation = loadInstallation(paths);
  const systemd = await command('/usr/bin/systemctl', ['--version'], { timeout: 5000 });
  const version = Number(/^systemd (\d+)/.exec(systemd)?.[1] || 0);
  if (version < 257) fail('directory_systemd_unsupported');
  const node = (await command(path.join(installation.nodeRoot, 'node'), ['--version'], { timeout: 5000 })).trim();
  if (!/^v(?:22|24)\./.test(node)) fail('directory_node_unsupported');
  const tini = await command(path.join(installation.nodeRoot, 'tini'), ['--version'], { timeout: 5000 });
  if (!/^tini version 0\.(?:19|[2-9]\d)\./.test(tini)) fail('directory_tini_unsupported');
  const libraries = await command('/usr/bin/ldd', [path.join(installation.browserRoot, 'chrome')], { timeout: 5000 });
  if (libraries.includes('not found')) fail('directory_browser_libraries_missing');
  const namespaces = ['pid', 'user', 'mnt', 'ipc', 'net'].every(name => fs.existsSync(`/proc/self/ns/${name}`));
  if (!namespaces) fail('directory_namespaces_unsupported');
  if (!fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) fail('directory_cgroups_unsupported');
  for (const executable of ['/usr/bin/mount', '/usr/bin/umount', '/usr/bin/fallocate', '/usr/sbin/mkfs.ext4', '/usr/sbin/blkid']) {
    try { fs.accessSync(executable, fs.constants.X_OK); } catch { fail('directory_volume_tools_missing'); }
  }
  if (!fs.readFileSync('/proc/filesystems', 'utf8').split('\n').some(line => line.trim() === 'ext4')) fail('directory_volume_filesystem_missing');
  // Read-only capability check. Installation never edits the host's browser
  // AppArmor policy or weakens the sandbox to make a missing prerequisite pass.
  const apparmor = fs.existsSync('/sys/module/apparmor/parameters/enabled')
    && fs.readFileSync('/sys/module/apparmor/parameters/enabled', 'utf8').trim() === 'Y';
  if (apparmor && !fs.existsSync('/etc/apparmor.d/dispatch-native-chrome')) fail('directory_browser_policy_required');
  await command('/usr/bin/sudo', ['-n', '--', '/usr/bin/true'], { timeout: 5000 });
  return { ok: true, nodeVersion: node, systemdVersion: version, namespaces, cgroups: true,
    browserLibraries: true, browserPolicy: apparmor ? 'host_policy_present' : 'not_required', activation: true };
}

async function prepareStartup(paths, { port, apiPort } = {}) {
  paths = platformPaths(paths.platformRoot);
  const settings = loadDashboardSettings(paths);
  port ??= settings?.port ?? 4310;
  apiPort ??= port + 1;
  if (process.geteuid() === 0) fail('directory_startup_invalid');
  const checked = await preflight(paths), installation = loadInstallation(paths);
  const config = unitValue(path.join(paths.local, 'config/platform.json'));
  const node = unitValue(path.join(installation.nodeRoot, 'node'));
  const source = unitValue(paths.live);
  unitValue(path.join(source, 'bin/dispatch-api'));
  unitValue(path.join(source, 'bin/dispatch-dashboard'));
  const units = require('./api-units').renderApiUnits({ source, node, config,
    uid: process.geteuid(), gid: process.getegid(), port, apiPort, publicOrigin: settings?.publicOrigin ?? null });
  if (require('../../core/updates/configuration').loadConfiguration(paths)) units['dispatch-updates.service'] = require('../releases/setup').workerUnit({ paths, node, uid: process.geteuid(), gid: process.getegid() });
  const root = privateDirectory(path.join(paths.local, 'systemd'));
  const unitFiles = Object.entries(units).map(([name, content]) => {
    const file = path.join(root, name); atomic(file, content); return file;
  });
  await command('/usr/bin/systemd-analyze', ['verify', ...unitFiles], { timeout: 10000 });
  return { ...checked, status: 'startup_prepared', unitFile: path.join(root, 'dispatch-platform-local.service'),
    unitFiles, apiUnitFile: path.join(root, 'dispatch-api.service'), port, apiPort };
}

module.exports = { preflight, prepareStartup };
