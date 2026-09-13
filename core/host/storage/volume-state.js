'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { privateJson } = require('../../core/installations/src/release-delivery-files');
const { fail } = require('../controller/operations');

const VOLUME_DIRECTORIES = Object.freeze(['config', 'data', 'secrets', 'state', 'run', 'staging', 'logs', 'backups', 'browser', '.storage-view', 'plugins']);
const decode = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

function mounts(text = fs.readFileSync('/proc/self/mountinfo', 'utf8')) {
  return new Map(text.trim().split('\n').filter(Boolean).map(line => {
    const [before, after] = line.split(' - '), fields = before.split(' '), type = after.split(' ');
    return [decode(fields[4]), { device: fields[2], root: decode(fields[3]), options: fields[5].split(','),
      type: type[0], source: decode(type[1]) }];
  }));
}

function volumeState(root) {
  const value = privateJson(path.join(root, '.volume.json'), process.geteuid(), true);
  if (!value) return null;
  if (Object.keys(value).sort().join(',') !== 'bytes,id,phase,uuid,version' || ![1, 2].includes(value.version)
      || value.id !== path.basename(root) || !/^dsp_[a-f0-9]{32}$/.test(value.id)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.uuid)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 64 * 1024 ** 2 || value.bytes > 64 * 1024 ** 3
      || !['allocating', 'formatting', 'formatted', 'populated', 'ready'].includes(value.phase)) fail('directory_volume_unsafe');
  return value;
}

function volumeFiles(root, value) {
  return { image: path.join(root, `.volume-${value.uuid}.img`), mount: path.join(root, '.volume') };
}

function imageInfo(file, value) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0
      || (info.mode & 0o7777) !== 0o600 || info.size !== value.bytes || fs.realpathSync(file) !== file) fail('directory_volume_unsafe');
  return info;
}

function mountedVolume(root, value, table = mounts()) {
  const files = volumeFiles(root, value), entry = table.get(files.mount);
  if (!entry || entry.type !== 'ext4' || entry.root !== '/'
      || !['rw', 'nodev', 'nosuid', 'noexec'].every(option => entry.options.includes(option))) fail('directory_volume_unmounted');
  imageInfo(files.image, value);
  const backing = fs.readFileSync(`/sys/dev/block/${entry.device}/loop/backing_file`, 'utf8').trim();
  if (path.resolve('/', backing) !== files.image) fail('directory_volume_unsafe');
  return entry;
}

function assertVolumeMounted(root, value = volumeState(root)) {
  if (!value) return null; // Earlier directory layouts are migrated explicitly while stopped.
  if (value.phase !== 'ready') fail('directory_volume_incomplete');
  const table = mounts(), volume = mountedVolume(root, value, table);
  for (const name of VOLUME_DIRECTORIES) {
    if (value.version === 1 && name === 'plugins') continue;
    const bind = table.get(path.join(root, name));
    if (!bind || bind.device !== volume.device || bind.root !== `/${name}`
        || !['rw', 'nodev', 'nosuid', 'noexec'].every(option => bind.options.includes(option))) fail('directory_volume_unmounted');
  }
  return value;
}

module.exports = { VOLUME_DIRECTORIES, mounts, volumeState, volumeFiles, imageInfo, mountedVolume, assertVolumeMounted };
