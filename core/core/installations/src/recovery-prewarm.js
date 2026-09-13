'use strict';
// Only immutable release payloads are warmed. Mutable snapshots and credentials
// remain captured afresh by the ordinary backup pipeline before each rollout.
const fs = require('node:fs');
const path = require('node:path');
const {atomic} = require('./release-delivery-files');
const {releaseRoot, prepareRelease} = require('./recovery-artifacts');
const BASES = ['platform','runtime','control','updater','release-delivery'].map(name => `/opt/dispatch-${name}/releases`);
function candidates(bases = BASES) {
  const roots = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const parent = fs.lstatSync(base);
    if (parent.uid !== 0 || !parent.isDirectory() || parent.mode & 0o022 || fs.realpathSync(base) !== base) throw Error('unsafe_recovery_root');
    for (const entry of fs.readdirSync(base, {withFileTypes:true})) {
      const root = path.join(base, entry.name);
      // Installation stages are not complete immutable release roots yet.
      if (entry.isDirectory() && !entry.name.endsWith('.pending') && releaseRoot(root)) {
        const stat = fs.lstatSync(root);
        if (stat.uid === 0 && (stat.mode & 0o222) === 0) roots.push(root);
      }
    }
  }
  return roots;
}
function prewarm({roots = candidates(), prepare = prepareRelease, report = () => {}, clock = Date.now,
  config = require('./offsite-backup').loadConfig()} = {}) {
  let prepared = 0, failed = 0;
  const startedAt = clock(), stages = [];
  report({ schemaVersion: 1, status: 'running', startedAt, checkedAt: clock(), prepared, failed, stages });
  for (const root of roots) {
    const start = clock();
    let status = 'verified';
    try { prepare(config, root); prepared++; } catch { failed++; status = 'failed'; }
    stages.push({ component: root.split('/')[2], releaseId: path.basename(root), status, durationMs: clock() - start });
    report({ schemaVersion: 1, status: 'running', startedAt, checkedAt: clock(), prepared, failed, stages: stages.slice(-100) });
  }
  report({ schemaVersion: 1, status: failed ? 'attention' : 'ready', startedAt, checkedAt: clock(),
    durationMs: clock() - startedAt, prepared, failed, stages: stages.slice(-100) });
  return {status:failed ? 'recovery_prewarm_incomplete' : 'recovery_prewarmed', prepared, failed};
}
function install(executable, localRoot) {
  atomic('/etc/systemd/system/dispatch-recovery-prewarm.service', `[Unit]\nDescription=Prepare immutable Dispatch recovery files ahead of backups\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUMask=0077\nNice=10\nIOSchedulingClass=idle\nExecStart=/usr/bin/node --no-warnings ${executable} prewarm\nTimeoutStartSec=1h\n`, 0o644);
  atomic('/etc/systemd/system/dispatch-recovery-prewarm.timer', '[Unit]\nDescription=Keep Dispatch recovery files prepared\n\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=15min\n\n[Install]\nWantedBy=timers.target\n', 0o644);
  if (localRoot) atomic('/etc/systemd/system/dispatch-recovery-prewarm.path', `[Unit]\nDescription=Prepare immutable recovery files during release preflight\n\n[Path]\nPathChanged=${localRoot}/run/release-preflight\nUnit=dispatch-recovery-prewarm.service\n\n[Install]\nWantedBy=multi-user.target\n`, 0o644);
}
module.exports = {candidates, prewarm, install};
