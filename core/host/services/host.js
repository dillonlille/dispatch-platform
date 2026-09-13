'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { inspectDsp } = require('../storage/storage');
const { serviceSpec, SOURCE_DIRECTORIES } = require('./service');
const { privateDirectory, privileged, fail } = require('../controller/operations');
const { DirectoryVolumes } = require('../storage/volume');

const unitName = id => `dispatch-directory-${validateDspId(id).slice(4)}.service`;
const fingerprint = spec => crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');

class DirectoryHost {
  constructor(paths, installation) { this.paths = paths; this.installation = installation; this.volumes = new DirectoryVolumes(paths); }

  async prepare(id, lockFd) {
    const dsp = inspectDsp(this.paths, id, { allowUnmounted: true });
    await this.volumes.ensure(dsp, lockFd);
    for (const name of ['data/auth-broker', 'secrets/auth-broker', 'state/auth-broker']) privateDirectory(path.join(dsp.root, name));
    privateDirectory(path.join(dsp.root, '.control'));
    const root = path.join(dsp.root, '.service-root'), view = path.join(dsp.root, '.code-view');
    for (const selected of [root, view]) {
      if (!fs.existsSync(selected)) continue;
      const info = fs.lstatSync(selected);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022
          || fs.realpathSync(selected) !== selected) fail('directory_host_boundary');
    }
    await privileged(['/usr/bin/install', '-d', '-m', '755', '-o', '0', '-g', '0', root,
      ...['', 'dependencies', 'dependencies/browser', ...SOURCE_DIRECTORIES]
        .map(name => path.join(view, name))], { lockFd });
    for (const [name, target] of [['lib', 'usr/lib'], ['lib64', 'usr/lib64'], ['bin', 'usr/bin'], ['sbin', 'usr/sbin']]) {
      const file = path.join(root, name);
      let info;
      try { info = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info) {
        if (!info.isSymbolicLink() || info.uid !== 0 || fs.readlinkSync(file) !== target) fail('directory_host_boundary');
      } else await privileged(['/usr/bin/ln', '-s', '--', target, file], { lockFd });
    }
    serviceSpec(this.paths, id, this.installation);
  }

  async state(id, lockFd) {
    const spec = serviceSpec(this.paths, id, this.installation);
    const output = await privileged(['/usr/bin/systemctl', 'show', unitName(id),
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'User', '-p', 'RootDirectory', '-p', 'Description'], { lockFd });
    const state = Object.fromEntries(output.trim().split('\n').map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    if (state.LoadState !== 'not-found' && (state.User !== spec.properties.User
        || state.RootDirectory !== spec.properties.RootDirectory
        || state.Description !== `Dispatch directory runtime ${fingerprint(spec)}`)) fail('directory_host_boundary');
    return { loaded: state.LoadState !== 'not-found', active: ['active', 'activating'].includes(state.ActiveState),
      pid: Number(state.MainPID || 0), status: state.ActiveState || 'inactive' };
  }

  async start(id, lockFd) {
    const state = await this.state(id, lockFd);
    if (state.active) return state;
    if (state.loaded) {
      await privileged(['/usr/bin/systemctl', 'start', unitName(id)], { lockFd });
    } else {
      const spec = serviceSpec(this.paths, id, this.installation);
      const args = ['/usr/bin/systemd-run', '--quiet', '--collect', '--unit', unitName(id),
        '--property', `Description=Dispatch directory runtime ${fingerprint(spec)}`];
      for (const [name, value] of Object.entries(spec.properties)) args.push('--property', `${name}=${value}`);
      for (const [name, value] of Object.entries(spec.environment)) args.push('--setenv', `${name}=${value}`);
      args.push('--', ...spec.command);
      await privileged(args, { lockFd });
    }
    return this.state(id, lockFd);
  }

  async stop(id, lockFd) {
    const state = await this.state(id, lockFd);
    if (state.loaded) await privileged(['/usr/bin/systemctl', 'stop', unitName(id)], { lockFd });
    const after = await this.state(id, lockFd);
    if (after.active || after.pid !== 0) fail('directory_stop_failed');
    return after;
  }
}

module.exports = { DirectoryHost, unitName };
