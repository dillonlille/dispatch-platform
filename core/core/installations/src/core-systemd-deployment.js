'use strict';

// Release-local entrypoints used by the independent platform updater. The bundle
// is verified before invocation; no paths or commands come from a browser.
const fs = require('node:fs');
const path = require('node:path');
const { verifyPreparedHostArtifact } = require('./oci-host-artifact');
function atomic(file, contents, mode = 0o600) {
  const tmp = `${file}.new-${process.pid}`;
  fs.writeFileSync(tmp, contents, { flag: 'wx', mode });
  const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
async function input() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 4096) throw new Error(); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function main(action, artifactRoot) {
  const config = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'deployment.json'), 'utf8'));
  if (artifactRoot !== `/opt/dispatch-platform/releases/${config.releaseId}/core-artifact`) throw new Error();
  if (action === 'prepare-backup') {
    if (process.geteuid() !== 0 || !fs.existsSync('/etc/dispatch/offsite-backup.json')) throw new Error();
    if (require('./core-recovery-host').rootArtifact(config.releaseId).root !== artifactRoot) throw new Error();
    const unit = `dispatch-backup-enable-${config.releaseId}.service`;
    atomic(`/etc/systemd/system/${unit}`, `[Unit]\nDescription=Prepare complete Dispatch recovery backups\nAfter=network-online.target\n\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/node --no-warnings ${artifactRoot}/code/core/installations/bin/dispatch-offsite-backup enable\nTimeoutStartSec=1h\n`, 0o644);
    for (const args of [['daemon-reload'], ['start', '--no-block', unit]]) {
      if (require('node:child_process').spawnSync('/usr/bin/systemctl', args, { timeout: 30000 }).status !== 0) throw new Error();
    }
    return;
  }
  if (action === 'switch-host') {
    if (process.geteuid() !== 0) throw new Error();
    const helper = `/opt/dispatch-control/releases/${config.releaseId}/host-helper-artifact`;
    verifyPreparedHostArtifact(`${helper}/core/installations/bin/dispatch-oci-host-issuer`, config.releaseId, config.helperManifestSha256, 'dispatch-oci-host-issuer');
    const hostFile = '/etc/dispatch/oci-host.json';
    const current = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
    current.controlReleaseId = config.releaseId; current.helperManifestSha256 = config.helperManifestSha256;
    atomic(hostFile, JSON.stringify(current) + '\n');
    const link = `/opt/dispatch-control/current.new-${process.pid}`;
    fs.symlinkSync(`/opt/dispatch-control/releases/${config.releaseId}`, link);
    fs.renameSync(link, '/opt/dispatch-control/current');
    // The watcher remains a separate service, but shares this installed Core
    // release's code. Reloading its definition does not interrupt a running job.
    atomic('/etc/systemd/system/dispatch-release-watch.service',
      `[Unit]\nDescription=Discover and prepare Dispatch releases\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/node --no-warnings ${artifactRoot}/code/core/installations/bin/dispatch-release-watch\nEnvironment=PATH=/usr/bin:/bin\nUMask=0022\nTimeoutStartSec=45min\nTimeoutStopSec=30s\nKillMode=control-group\nPrivateTmp=true\nProtectSystem=full\nReadWritePaths=/etc/sudoers.d /etc/apparmor.d\nProtectKernelTunables=true\nProtectControlGroups=true\n`, 0o644);
    require('./release-ready-notify').install(config.localRoot);
    if (require('node:child_process').spawnSync('/usr/bin/systemctl', ['daemon-reload'], { timeout: 30000 }).status !== 0) throw new Error();
    if (require('node:child_process').spawnSync('/usr/bin/systemctl', ['enable', '--now', 'dispatch-release-watch.path'], { timeout:30000 }).status !== 0) throw new Error();
    // Bootstrap the independently supervised backup worker from this verified
    // release. It confirms encrypted uploads before making backups
    // mandatory. A Core restart must not kill an in-progress backup export.
    if (fs.existsSync('/etc/dispatch/offsite-backup.json')) {
      const { spawnSync } = require('node:child_process');
      const enableUnit = `dispatch-backup-enable-${config.releaseId}.service`;
      atomic(`/etc/systemd/system/${enableUnit}`,
        `[Unit]\nDescription=Verify and enable Dispatch backup protection\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/node --no-warnings ${artifactRoot}/code/core/installations/bin/dispatch-offsite-backup enable\nTimeoutStartSec=1h\n`, 0o644);
      for (const args of [['daemon-reload'], ['start', '--no-block', enableUnit]]) {
        if (spawnSync('/usr/bin/systemctl', args, {timeout:30000}).status !== 0) throw new Error();
      }
    }
    return;
  }
  if (process.geteuid() === 0 || !['apply', 'verify'].includes(action)) throw new Error();
  const context = await input();
  if (context.protocolVersion !== 1 || context.action !== action || context.releaseId !== config.releaseId
      || context.sourceCommit !== config.sourceCommit || context.version !== config.version
      || !/^rollout_[a-f0-9]{32}$/.test(context.rolloutId)) throw new Error();
  const recovery = require('./core-recovery').createCoreRecovery({ localRoot: config.localRoot, context,
    adapter: require('./core-recovery-host').createHostRecovery(config, artifactRoot) });
  await recovery[action]();
  process.stdout.write(JSON.stringify({ ok: true, releaseId: config.releaseId, version: config.version, sourceCommit: config.sourceCommit }) + '\n');
}
module.exports = { main };
