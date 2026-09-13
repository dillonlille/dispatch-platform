'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { directory } = require('../../shared/paths/platform-paths');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, privileged, syncDirectory, fail } = require('../controller/operations');
const { VOLUME_DIRECTORIES, mounts, volumeState, volumeFiles, imageInfo, mountedVolume, assertVolumeMounted } = require('./volume-state');

function volumePolicy(paths) {
  const value = privateJson(path.join(paths.local, 'config/directory-storage.json'), process.geteuid(), true)
    || { version: 1, dspGiB: 4, reserveGiB: 8 };
  if (Object.keys(value).sort().join(',') !== 'dspGiB,reserveGiB,version' || value.version !== 1
      || !Number.isInteger(value.dspGiB) || value.dspGiB < 1 || value.dspGiB > 64
      || !Number.isInteger(value.reserveGiB) || value.reserveGiB < 4 || value.reserveGiB > 1024) fail('directory_volume_policy_invalid');
  return { bytes: value.dspGiB * 1024 ** 3, reserveBytes: value.reserveGiB * 1024 ** 3 };
}

function pristine(root) {
  for (const name of VOLUME_DIRECTORIES) {
    const scan = selected => {
      for (const item of fs.readdirSync(selected, { withFileTypes: true })) {
        const file = path.join(selected, item.name);
        if (item.isDirectory()) { directory(file); if (!scan(file)) return false; }
        else if (![path.join(root, 'config/dsp.json'), path.join(root, 'config/storage-layout.json')].includes(file) || !item.isFile()) return false;
      }
      return true;
    };
    if (!scan(path.join(root, name))) return false;
  }
  return true;
}

// Every privileged command inherits the platform operation lock. Images and
// mount points are derived from a validated DSP; no caller-supplied device,
// mount options or shell commands cross this boundary.
class DirectoryVolumes {
  constructor(paths, policy = volumePolicy(paths)) {
    if (!Number.isSafeInteger(policy.bytes) || policy.bytes < 64 * 1024 ** 2 || policy.bytes > 64 * 1024 ** 3
        || !Number.isSafeInteger(policy.reserveBytes) || policy.reserveBytes < 4 * 1024 ** 3) fail('directory_volume_policy_invalid');
    this.paths = paths; this.policy = policy;
  }

  async ensure(dsp, lockFd) {
    directory(dsp.root);
    privateDirectory(path.join(dsp.root, 'plugins'));
    privateDirectory(path.join(dsp.root, '.storage-view/plugins'));
    let value = volumeState(dsp.root);
    if (value?.version === 1 && value.phase === 'ready') {
      await this.stopped(dsp, lockFd);
      const files = volumeFiles(dsp.root, value);
      if (mounts().has(files.mount)) {
        mountedVolume(dsp.root, value);
        const source = privateDirectory(path.join(files.mount, 'plugins'));
        if (fs.readdirSync(path.join(dsp.root, 'plugins')).length) fail('directory_plugin_volume_migration_required');
        if (!mounts().has(path.join(dsp.root, 'plugins'))) await privileged(['/usr/bin/mount', '--bind', '--', source, path.join(dsp.root, 'plugins')], { lockFd });
        value.version = 2; atomic(path.join(dsp.root, '.volume.json'), value);
      }
    }
    if (value?.phase === 'ready') {
      try { assertVolumeMounted(dsp.root, value); return { limited: true, bytes: value.bytes }; }
      catch (error) { if (error.code !== 'directory_volume_unmounted') throw error; }
    }
    if (!value) {
      // Preserve existing data and running connections during the staged rebuild.
      // Conversion of a populated DSP is a separate, stopped migration operation.
      if (dsp.backend !== 'directory_service_v1' || !pristine(dsp.root)) return { limited: false };
      await this.stopped(dsp, lockFd);
      const available = fs.statfsSync(this.paths.dsps);
      if (available.bavail * available.bsize < this.policy.bytes + this.policy.reserveBytes) fail('directory_storage_capacity');
      value = { version: 2, id: dsp.id, uuid: crypto.randomUUID(), bytes: this.policy.bytes, phase: 'allocating' };
      atomic(path.join(dsp.root, '.volume.json'), value);
    }
    await this.stopped(dsp, lockFd);
    const files = volumeFiles(dsp.root, value), run = args => privileged(args, { lockFd, timeout: 120000 });
    const save = phase => { value.phase = phase; atomic(path.join(dsp.root, '.volume.json'), value); };
    if (['allocating', 'formatting'].includes(value.phase)) {
      if (mounts().has(files.mount) || !pristine(dsp.root)) fail('directory_volume_unsafe');
      if (!fs.existsSync(files.image)) {
        fs.closeSync(fs.openSync(files.image, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600));
        syncDirectory(dsp.root);
      }
      const initial = fs.lstatSync(files.image);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.mode & 0o077
          || ![0, process.geteuid()].includes(initial.uid) || ![0, value.bytes].includes(initial.size)) fail('directory_volume_unsafe');
      await run(['/usr/bin/chown', '0:0', '--', files.image]);
      await run(['/usr/bin/fallocate', '--length', String(value.bytes), '--', files.image]);
      imageInfo(files.image, value);
      save('formatting');
      await run(['/usr/sbin/mkfs.ext4', '-q', '-F', '-m', '0', '-U', value.uuid,
        '-E', `nodiscard,lazy_itable_init=0,lazy_journal_init=0,root_owner=${process.geteuid()}:${process.getegid()}`, files.image]);
      await run(['/usr/bin/sync', '-f', files.image]);
      save('formatted');
    }
    imageInfo(files.image, value);
    if (!mounts().has(files.mount)) privateDirectory(files.mount);
    else directory(files.mount);
    if (!mounts().has(files.mount)) {
      const uuid = (await run(['/usr/sbin/blkid', '-s', 'UUID', '-o', 'value', files.image])).trim();
      if (uuid !== value.uuid) fail('directory_volume_unsafe');
      await run(['/usr/bin/mount', '-t', 'ext4', '-o', 'loop,rw,nosuid,nodev,noexec', '--', files.image, files.mount]);
    }
    const mounted = mountedVolume(dsp.root, value);
    directory(files.mount);
    fs.chmodSync(files.mount, 0o700);
    if (value.phase === 'formatted') {
      if (!pristine(dsp.root)) fail('directory_volume_unsafe');
      for (const name of VOLUME_DIRECTORIES) {
        fs.cpSync(path.join(dsp.root, name), path.join(files.mount, name), { recursive: true, force: true, verbatimSymlinks: true });
      }
      await run(['/usr/bin/sync', '-f', files.mount]);
      save('populated');
    }
    for (const name of VOLUME_DIRECTORIES) {
      const target = path.join(dsp.root, name), source = path.join(files.mount, name);
      if (name === 'plugins' && value.version === 1) privateDirectory(source);
      directory(target); directory(source);
      const bind = mounts().get(target);
      if (bind) {
        if (bind.device !== mounted.device || bind.root !== `/${name}`) fail('directory_volume_unsafe');
      } else await run(['/usr/bin/mount', '--bind', '--', source, target]);
    }
    if (value.phase === 'populated') save('ready');
    if (value.version === 1) { value.version = 2; atomic(path.join(dsp.root, '.volume.json'), value); }
    assertVolumeMounted(dsp.root, value);
    return { limited: true, bytes: value.bytes };
  }

  // Used by stopped migration/acceptance workflows. Normal controller exits
  // retain mounts because DSP services are independent of the controller.
  async unmount(dsp, lockFd) {
    const value = volumeState(dsp.root);
    if (!value) return;
    const files = volumeFiles(dsp.root, value);
    if (!mounts().has(files.mount)) return;
    await this.stopped(dsp, lockFd);
    mountedVolume(dsp.root, value);
    for (const name of [...VOLUME_DIRECTORIES].reverse()) {
      const target = path.join(dsp.root, name), bind = mounts().get(target);
      if (!bind) continue;
      const volume = mountedVolume(dsp.root, value);
      if (bind.device !== volume.device || bind.root !== `/${name}`) fail('directory_volume_unsafe');
      await privileged(['/usr/bin/umount', '--', target], { lockFd });
    }
    await privileged(['/usr/bin/umount', '--', files.mount], { lockFd });
  }

  async stopped(dsp, lockFd) {
    const output = await privileged(['/usr/bin/systemctl', 'show', `dispatch-directory-${dsp.id.slice(4)}.service`,
      '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID'], { lockFd });
    const state = Object.fromEntries(output.trim().split('\n').map(line => line.split('=')));
    if (!['inactive', 'failed'].includes(state.ActiveState) || state.MainPID !== '0' || state.ControlPID !== '0') fail('directory_volume_runtime_active');
  }
}

module.exports = { DirectoryVolumes, volumePolicy, pristine };
