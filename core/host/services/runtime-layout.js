'use strict';

const path = require('node:path');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { MANAGED_INSTALLATION_LAYOUT_VERSION, MANAGED_INSTALLATION_DIRECTORY_FIELDS, managedInstallationRuntimeEnvironment } = require('../../shared/paths/runtime-paths');
const { STORAGE_DIRECTORIES, inspectStorageView } = require('../storage/storage');

const CODE_ROOT = '/opt/dispatch';
const NODE_ROOT = '/opt/dispatch-tools';
const BROWSER_ROOT = `${CODE_ROOT}/dependencies/browser`;
const BRIDGE_ROOT = '/run/dispatch-agent';

function runtimeEnvironment(id) {
  const installationRoot = `/var/lib/dispatch/${validateDspId(id)}`;
  const layout = { layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION, templateId: 'isolated_dsp_v1', runtimeKey: id,
    projectRoot: CODE_ROOT, installationRoot,
    directories: Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
      .map(([field, relative]) => [field, path.join(installationRoot, relative)])) };
  return Object.freeze({
    HOME: '/tmp', PATH: `${NODE_ROOT}:${CODE_ROOT}/bin`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    NODE_NO_WARNINGS: '1', DISPATCH_MANAGED_RUNTIME: '1', ...managedInstallationRuntimeEnvironment(layout),
    DISPATCH_RUNTIME_KEY: id,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(installationRoot, 'run/runtime-gateway.sock'),
  });
}

// Both launchers expose exactly this storage view. Host control files are
// deliberately outside it, even though they share the same DSP parent directory.
function storageMounts(dsp) {
  const target = path.dirname(runtimeEnvironment(dsp.id).DISPATCH_DATA_ROOT);
  return [
    { source: inspectStorageView(dsp), target },
    ...STORAGE_DIRECTORIES.map(name => ({ source: path.join(dsp.root, name), target: path.join(target, name) })),
  ];
}

module.exports = { CODE_ROOT, NODE_ROOT, BROWSER_ROOT, BRIDGE_ROOT, runtimeEnvironment, storageMounts };
