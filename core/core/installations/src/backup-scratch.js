'use strict';
const fs = require('node:fs'), path = require('node:path');
// Call only while holding the offsite worker lock, before starting any transfer.
// Interrupted exports/restores can contain full tenant history after a reboot.
function cleanupBackupScratch(root, ownerUid = 0) {
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.uid !== ownerUid || directory.mode & 0o077
      || fs.realpathSync(root) !== root) throw Error('unsafe_backup_scratch');
  for (const name of fs.readdirSync(root)) {
    if (!/^(archive-transfer|archive-restore|rediscover|transfer|canary)-[A-Za-z0-9]{6}$/.test(name)) continue;
    const file = path.join(root, name), info = fs.lstatSync(file);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUid
        || info.mode & 0o077 || fs.realpathSync(file) !== file) throw Error('unsafe_backup_scratch');
    fs.rmSync(file, { recursive: true });
  }
}
function cleanupRestoreStaging(root = '/var/lib/dispatch-restore-staging', ownerUid = 0) {
  if (!fs.existsSync(root)) return;
  const parent = fs.lstatSync(root);
  if (!parent.isDirectory() || parent.uid !== ownerUid || (parent.mode & 0o7777) !== 0o711
      || fs.realpathSync(root) !== root) throw Error('unsafe_backup_scratch');
  for (const name of fs.readdirSync(root)) {
    if (!/^import-[A-Za-z0-9]{6}$/.test(name)) continue;
    const file = path.join(root, name), info = fs.lstatSync(file);
    // Import directories are handed to the selected DSP UID. The parent stays
    // root-owned and non-writable, so DSPs cannot create or replace these names.
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077
        || fs.realpathSync(file) !== file) throw Error('unsafe_backup_scratch');
    fs.rmSync(file, { recursive: true });
  }
}
module.exports = { cleanupBackupScratch, cleanupRestoreStaging };
