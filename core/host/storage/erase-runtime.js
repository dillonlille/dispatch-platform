'use strict';
const fs = require('node:fs'), path = require('node:path');
const { directory, validateDspId } = require('../../shared/paths/platform-paths');
const { privileged, fail, syncDirectory } = require('../controller/operations');
const { mounts } = require('./volume-state');

async function eraseRuntime(paths, job, volumes, lockFd, run = privileged) {
  const root = path.join(paths.dsps, validateDspId(job.runtimeKey));
  directory(paths.dsps);
  if (!fs.existsSync(root)) return;
  directory(root);
  const info = fs.lstatSync(root);
  if (info.ino !== job.rootInode || info.dev !== job.rootDevice) fail('directory_deletion_identity_changed');
  await volumes.stopped({ id: job.runtimeKey, root }, lockFd);
  await volumes.unmount({ id: job.runtimeKey, root }, lockFd);
  if ([...mounts().keys()].some(mount => mount === root || mount.startsWith(root + '/'))) fail('directory_deletion_mounted');
  // rm does not follow symlinks. The worker is stopped, all mounts are detached,
  // and the validated private parent is locked against other host operations.
  await run(['/usr/bin/rm', '-rf', '--one-file-system', '--', root], { lockFd });
  if (fs.existsSync(root)) fail('directory_deletion_incomplete');
  syncDirectory(paths.dsps);
}
module.exports = { eraseRuntime };
