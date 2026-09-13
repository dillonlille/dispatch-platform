'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Render host-local deployment files around an already verified portable code tree.
function finishCoreArtifact(root, config) {
  const write = (relative, contents, mode = 0o444) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { flag: 'wx', mode });
  };
  write('deployment.json', JSON.stringify(config) + '\n');
  for (const action of ['apply', 'verify', 'switch-host', 'prepare-backup']) write(action,
    `#!/usr/bin/node --no-warnings\n'use strict';\nrequire([__dirname,'code','core','installations','src','core-systemd-deployment'].join('/')).main('${action}', __dirname).catch(() => { process.stderr.write('core_stage_failed\\n'); process.exitCode=1; });\n`, 0o555);
  const source = `/opt/dispatch-platform/releases/${config.releaseId}/core-artifact/code`;
  const environment = `Environment=PATH=/usr/bin:/bin\nEnvironment=NODE_NO_WARNINGS=1\nEnvironment=DISPATCH_LOCAL_ROOT=${config.localRoot}\nEnvironmentFile=${config.localRoot}/config/provisioning.env\n`;
  write('units/dispatch-platform-update.service', `[Unit]\nDescription=Dispatch Core update supervisor\nAfter=network-online.target\n\n[Service]\nType=oneshot\n${environment}ExecStart=/usr/bin/node --no-warnings ${source}/core/installations/bin/dispatch-platform-update\nTimeoutStartSec=90min\nTimeoutStopSec=30s\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=false\n`);
  write('units/dispatch-dashboard.service', `[Unit]\nDescription=Dispatch Platform\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${source}/dashboard\n${environment}EnvironmentFile=-${config.localRoot}/config/dashboard.env\nExecStart=${source}/bin/dispatch-dashboard --installation-operator --installation-backend native_service_v1 --port ${config.port} --secure-cookies --public-origin ${config.publicOrigin}\nRestart=always\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=15s\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`);
  write('units/dispatch-installation-reconcile.service', `[Unit]\nDescription=Dispatch isolated DSP reconciliation\nAfter=dispatch-dashboard.service\nWants=dispatch-dashboard.service\n\n[Service]\nType=oneshot\nWorkingDirectory=${source}\n${environment}ExecStart=/usr/bin/node --no-warnings ${source}/core/installations/bin/dispatch-installation-reconcile --limit=20\nTimeoutStartSec=3h\nTimeoutStopSec=30s\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=false\n`);
  for (const unit of ['dispatch-platform-update', 'dispatch-installation-reconcile']) write(`units/${unit}.timer`,
    `[Unit]\nDescription=Recover missed Dispatch worker wakeups\n\n[Timer]\nOnBootSec=15s\nOnUnitInactiveSec=60s\nAccuracySec=1s\nUnit=${unit}.service\n\n[Install]\nWantedBy=timers.target\n`);
  const files = [];
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file); fs.chmodSync(file, 0o555); }
      else files.push({ path: path.relative(root, file), mode: (stat.mode & 0o777).toString(8), sha256: sha(fs.readFileSync(file)) });
    }
  };
  visit(root);
  const manifest = JSON.stringify({ schemaVersion: 1, releaseId: config.releaseId, sourceCommit: config.sourceCommit, files }) + '\n';
  write('manifest.json', manifest); fs.chmodSync(root, 0o555);
  return sha(manifest);
}
module.exports = { finishCoreArtifact };
