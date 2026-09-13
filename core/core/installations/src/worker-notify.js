'use strict';
const fs = require('node:fs'), path = require('node:path');
// An unprivileged worker can signal only this fixed root-side exporter through
// its path unit. The file contains no command, path, credentials or job payload.
function exportReady(localRoot = process.env.DISPATCH_LOCAL_ROOT) {
  if (!localRoot || !path.isAbsolute(localRoot)) return;
  try {
    const root = path.join(localRoot, 'run');
    const s = fs.lstatSync(root);
    if (!s.isDirectory() || s.uid !== process.geteuid() || s.mode & 0o077 || fs.realpathSync(root) !== root) return;
    const fd = fs.openSync(path.join(root, 'backup-ready'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) return;
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, String(Date.now())); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch {} // Fallback exporter timer recovers missed notifications.
}
function userWorkers(config) {
  if (process.geteuid() !== 0) return;
  try {
    const account = require('./host-recovery-bundle').account(config.coreUid);
    require('node:child_process').spawnSync('/usr/sbin/runuser', ['--user', account.name, '--', '/usr/bin/env',
      `XDG_RUNTIME_DIR=/run/user/${account.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${account.uid}/bus`,
      '/usr/bin/systemctl', '--user', '--no-block', 'start', 'dispatch-installation-reconcile.service', 'dispatch-platform-update.service'],
    { timeout: 5000, stdio: 'ignore' });
  } catch {}
}
module.exports = { exportReady, userWorkers };
