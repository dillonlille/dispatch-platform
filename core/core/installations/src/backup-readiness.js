'use strict';
// Advisory metadata inspection while services are live. Snapshot/restore proofs
// remain mandatory under the ordinary stopped-service backup boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HOST_TENANT_ROOT, opaqueRuntimeSuffix } = require('../../runtime-host-identity');
const { publicRootJson, RECEIPTS } = require('./offsite-policy');
const { atomic } = require('./release-delivery-files');
const FILE = path.join(RECEIPTS, 'readiness.json');
const localIdentity = root => crypto.createHash('sha256').update(root).digest('hex');

function inspectInstallation(root, uid, { maxEntries = 100000, now = Date.now, deadline = now() + 15000 } = {}) {
  const issues = new Set();
  let entries = 0, bytes = 0;
  const device = fs.lstatSync(root).dev;
  function visit(file, scope) {
    if (++entries > maxEntries || now() > deadline) { issues.add('inspection_limit'); return; }
    let info;
    try { info = fs.lstatSync(file); } catch { issues.add('tree_changed_or_missing'); return; }
    if (info.isSymbolicLink()) { issues.add(scope === 'state' ? 'state_symlink' : 'backup_symlink'); return; }
    if (info.uid !== uid || info.dev !== device) { issues.add('backup_owner_or_device'); return; }
    if (info.isDirectory()) {
      if (fs.realpathSync(file) !== file) { issues.add('backup_symlink'); return; }
      if ((info.mode & 0o7777) !== 0o700) issues.add(/\/state\/auth-broker\/browser-sessions\/[a-f0-9]{32}\/chrome\/\.cache(?:\/fontconfig)?$/.test(file)
        ? 'browser_cache_directory_permissions' : 'backup_directory_permissions');
      const directory = fs.opendirSync(file);
      try {
        let entry;
        while ((entry = directory.readSync())) {
          if (entries >= maxEntries || now() > deadline) { issues.add('inspection_limit'); break; }
          visit(path.join(file, entry.name), scope);
        }
      } finally { directory.closeSync(); }
    } else if (info.isFile()) {
      if (info.mode & 0o077) issues.add('backup_file_permissions');
      if (info.nlink !== 1) issues.add('backup_hardlink');
      bytes += info.size;
      if (info.size > 2 * 1024 ** 3 || bytes > 8 * 1024 ** 3) issues.add('backup_size_limit');
    } else issues.add('backup_nonregular_file');
  }
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== uid || (rootInfo.mode & 0o7777) !== 0o700 || fs.realpathSync(root) !== root) {
    return { status: 'attention', issues: ['unsafe_installation_root'], entries: 0, bytes: 0 };
  }
  for (const scope of ['data', 'state', 'config', 'secrets/auth-broker']) visit(path.join(root, scope), scope);
  const backupRoot = path.join(root, 'backups');
  const backup = fs.lstatSync(backupRoot);
  if (!backup.isDirectory() || backup.uid !== uid || (backup.mode & 0o7777) !== 0o700 || fs.realpathSync(backupRoot) !== backupRoot) issues.add('unsafe_backup_directory');
  else {
    const space = fs.statfsSync(backupRoot);
    if (space.bavail * space.bsize < bytes * 3 + 64 * 1024 ** 2) issues.add('backup_insufficient_space');
  }
  return { status: issues.size ? 'attention' : 'ready', issues: [...issues].sort(), entries, bytes };
}

function inspectHost(config, { base = HOST_TENANT_ROOT, inspect = inspectInstallation, now = Date.now } = {}) {
  const members = [], deadline = now() + 45000;
  if (fs.existsSync(base)) {
    const stat = fs.lstatSync(base);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || fs.realpathSync(base) !== base) throw Error('unsafe_tenant_root');
    for (const suffix of fs.readdirSync(base)) {
      if (!/^[a-f0-9]{20}$/.test(suffix)) continue;
      const parent = path.join(base, suffix, 'runtime');
      if (fs.realpathSync(parent) !== parent) throw Error('unsafe_tenant_root');
      for (const runtime of fs.readdirSync(parent)) {
        if (opaqueRuntimeSuffix(runtime) !== suffix || members.length >= 100 || now() > deadline) throw Error('backup_readiness_limit');
        const root = path.join(parent, runtime), uid = fs.lstatSync(root).uid;
        if (uid === 0 || uid === config.coreUid) throw Error('unsafe_tenant_root');
        try { members.push({ runtimeKey: runtime, ...inspect(root, uid, { deadline, now }) }); }
        catch { members.push({ runtimeKey: runtime, status: 'attention', issues: ['inspection_failed'] }); }
      }
    }
  }
  return { schemaVersion: 1, localRootHash: localIdentity(config.localRoot), checkedAt: now(),
    status: members.some(m => m.status !== 'ready') ? 'attention' : 'ready', members };
}

function readReadiness(localRoot, { file = FILE, uid = 0, now = Date.now } = {}) {
  const result = publicRootJson(file, true, uid, 65536);
  if (!result) return { status: 'unavailable' };
  if (result.schemaVersion !== 1 || result.localRootHash !== localIdentity(localRoot)
      || !Number.isSafeInteger(result.checkedAt) || result.checkedAt > now() + 5000
      || !['ready', 'attention'].includes(result.status) || !Array.isArray(result.members)) throw Error('backup_readiness_invalid');
  return now() - result.checkedAt > 120000 ? { status: 'stale', checkedAt: result.checkedAt } : result;
}

function install(executable, localRoot) {
  const unit = '[Unit]\nDescription=Inspect Dispatch backup readiness\n\n[Service]\nType=oneshot\nUMask=0077\n'
    + `ExecStart=/usr/bin/node --no-warnings ${executable}\nTimeoutStartSec=60s\n`;
  atomic('/etc/systemd/system/dispatch-backup-readiness.service', unit, 0o644);
  atomic('/etc/systemd/system/dispatch-backup-readiness.timer', '[Unit]\nDescription=Refresh Dispatch backup readiness\n\n[Timer]\nOnBootSec=30s\nOnUnitInactiveSec=60s\n\n[Install]\nWantedBy=timers.target\n', 0o644);
  atomic('/etc/systemd/system/dispatch-backup-readiness.path', `[Unit]\nDescription=Check backups before release publication\n\n[Path]\nPathChanged=${localRoot}/run/release-preflight\nUnit=dispatch-backup-readiness.service\n\n[Install]\nWantedBy=multi-user.target\n`, 0o644);
}
module.exports = { FILE, localIdentity, inspectInstallation, inspectHost, readReadiness, install };
