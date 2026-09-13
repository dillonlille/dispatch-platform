'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { privateJson, atomic } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory } = require('../controller/operations');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function root(paths) { return path.join(paths.local, 'state/dsp-deletions'); }
function deleted(paths, id) {
  const file = path.join(root(paths), 'tombstones', hash(id) + '.json');
  if (!fs.existsSync(file)) return false;
  const value = privateJson(file, process.geteuid());
  if (value.version !== 1 || value.runtimeHash !== hash(id)) throw Error('directory_deletion_unsafe');
  return true;
}
function preventRevival(paths, id) {
  const folder = privateDirectory(path.join(root(paths), 'tombstones'));
  atomic(path.join(folder, hash(id) + '.json'), { version: 1, runtimeHash: hash(id) });
}
function assertRetained(paths, id) { if (deleted(paths, id)) throw Object.assign(Error('directory_dsp_deleted'), { code: 'directory_dsp_deleted' }); }
function assertRestorable(paths, id) {
  assertRetained(paths, id);
  const requests = path.join(root(paths), 'requests');
  if (!fs.existsSync(requests)) return;
  for (const name of fs.readdirSync(requests)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error('directory_deletion_unsafe');
    const job = privateJson(path.join(requests, name), process.geteuid());
    if (job.runtimeKey === id) throw Object.assign(Error('directory_deletion_in_progress'), { code: 'directory_deletion_in_progress' });
  }
}
module.exports = { root, hash, deleted, preventRevival, assertRetained, assertRestorable };
