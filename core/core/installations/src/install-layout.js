'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomic, privateJson } = require('./release-delivery-files');
// Host accounts and host-control authority are explicit prerequisites. This
// initializes only missing service-owned files, never existing data or secrets.
function initializeLayout(config) {
  const account = spawnSync('/usr/bin/getent', ['passwd', String(config.uid)], { encoding: 'utf8', timeout: 5000 });
  if (account.status !== 0 || Number(account.stdout.split(':')[3]) !== config.gid) throw Error('configured_service_account_required');
  function directory(selected, create = true) {
    if (!fs.existsSync(selected)) {
      directory(path.dirname(selected), create);
      if (create) { fs.mkdirSync(selected, { mode: 0o700 }); fs.chownSync(selected, config.uid, config.gid); }
    } else {
      const info = fs.lstatSync(selected);
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, config.uid].includes(info.uid) || info.mode & 0o022 || fs.realpathSync(selected) !== selected) throw Error('unsafe_installation_directory');
    }
  }
  const directories = [config.localRoot, config.unitRoot, ...['config', 'data', 'state/provisioner', 'secrets/oci-runtime-agents', 'run', 'installations', 'backups', 'logs'].map(name => path.join(config.localRoot, name))];
  for (const selected of directories) {
    directory(selected, false);
    if (fs.existsSync(selected) && fs.statSync(selected).uid !== config.uid) throw Error('installation_directory_owner_mismatch');
  }
  const files = { 'oci-releases.json': { schemaVersion: 1, releases: {} }, 'platform-releases.json': { schemaVersion: 1, releases: {} } };
  for (const name of Object.keys(files)) {
    const file = path.join(config.localRoot, 'config', name);
    if (fs.existsSync(file)) privateJson(file, config.uid);
  }
  for (const selected of directories) directory(selected);
  const env = {
    DISPATCH_LOCAL_ROOT: config.localRoot,
    DISPATCH_ACCESS_CONTROL_DATABASE_ROOT: path.join(config.localRoot, 'data/access-control'),
    DISPATCH_PROVISIONER_STATE_ROOT: path.join(config.localRoot, 'state/provisioner'),
    DISPATCH_INSTALLATIONS_ROOT: path.join(config.localRoot, 'installations'),
    DISPATCH_SYSTEMD_UNIT_ROOT: config.unitRoot,
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: path.join(config.localRoot, 'run/runtime-agent-hub.sock'),
    DISPATCH_RUNTIME_AGENT_CONTROL_SOCKET: path.join(config.localRoot, 'run/runtime-agent-control.sock'),
    DISPATCH_OCI_RELEASE_CATALOG_FILE: path.join(config.localRoot, 'config/oci-releases.json'),
    DISPATCH_OCI_RUNTIME_AGENT_CREDENTIAL_ROOT: path.join(config.localRoot, 'secrets/oci-runtime-agents'),
  };
  files['provisioning.env'] = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(config.localRoot, 'config', name);
    if (!fs.existsSync(file)) { atomic(file, value); fs.chownSync(file, config.uid, config.gid); }
  }
}
module.exports = { initializeLayout };
