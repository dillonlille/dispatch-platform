'use strict';
const path = require('node:path');
const { privateJson } = require('../../core/installations/src/release-delivery-files');
function operation(paths) {
  return privateJson(path.join(paths.local, 'state/updates/releases.json'), process.geteuid(), true)?.operation;
}
function dspUpdating(paths, dspId) { return operation(paths)?.dspId === dspId; }
function updating(paths, dspId) {
  const selected = operation(paths);
  return Boolean(selected && (selected.product === 'core' || selected.dspId === dspId));
}
function assertAvailable(paths, dspId) {
  if (updating(paths, dspId)) throw Object.assign(new Error('directory_update_in_progress'), { code: 'directory_update_in_progress' });
}
function healthAllowed(paths) { const selected = operation(paths); return !selected || ['starting', 'restoring'].includes(selected.phase); }
module.exports = { updating, dspUpdating, assertAvailable, healthAllowed };
