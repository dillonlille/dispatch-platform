'use strict';

// Acceptance-only launcher. The application runtime uses the directory service.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { directory, platformPaths } = require('../../../../shared/paths/platform-paths');
const { inspectDsp } = require('../../../../host/storage/storage');
const { CODE_ROOT, NODE_ROOT, runtimeEnvironment, storageMounts } = require('../../../../host/services/runtime-layout');

function fail() { throw new Error('directory_dsp_invalid'); }

// A minimal filesystem allowlist plus separate PID, IPC, network, user, mount,
// UTS and cgroup namespaces. Never bind the host root or the entire DSP parent.
// Network is isolated in this acceptance backend; provider access is a later gate.
function sandboxArguments(paths, id, { toolsRoot, script, scriptArguments = [] } = {}) {
  paths = platformPaths(paths.platformRoot);
  const dsp = inspectDsp(paths, id);
  const tools = directory(toolsRoot);
  if (!tools.startsWith(paths.local + path.sep)) fail();
  if (typeof script !== 'string' || path.isAbsolute(script) || path.normalize(script) !== script
      || script.startsWith('..') || !script.endsWith('.js') || !Array.isArray(scriptArguments)
      || scriptArguments.some(value => typeof value !== 'string' || value.includes('\0'))) fail();
  const source = path.join(paths.live, script);
  if (fs.realpathSync(source) !== source || !fs.statSync(source).isFile()) fail();
  const environment = runtimeEnvironment(id);
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
    '--hostname', 'dispatch-dsp', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--size', '536870912', '--tmpfs', '/tmp', '--chmod', '1777', '/tmp',
    '--ro-bind', paths.live, CODE_ROOT, '--ro-bind', tools, NODE_ROOT];
  for (const mount of storageMounts(dsp)) args.push('--bind', mount.source, mount.target);
  args.push('--remount-ro', '/', '--chdir', CODE_ROOT);
  for (const [name, value] of Object.entries(environment)) args.push('--setenv', name, value);
  args.push('--', `${NODE_ROOT}/node`, '--no-warnings', path.join(CODE_ROOT, script), ...scriptArguments);
  return args;
}

function startSandbox(paths, id, options) {
  return spawn('/usr/bin/bwrap', sandboxArguments(paths, id, options), {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
}

module.exports = { sandboxArguments, startSandbox };
