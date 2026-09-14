import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chromium } from 'playwright';
import type { Config } from '../config.js';
import { assert } from '../../shared/errors.js';
function sandboxExecutable(config: Config) {
  const executable = fs.realpathSync(config.sandboxExecutable || '/usr/bin/bwrap');
  const info = fs.statSync(executable);
  assert(
    info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0,
    'trusted_browser_sandbox_required',
    503,
  );
  return executable;
}
// Check before entering the user namespace, where host UID 0 becomes unmapped.
function trustedBrowserExecutable(file: string) {
  const resolved = fs.realpathSync(file);
  const executable = fs.statSync(resolved);
  assert(
    executable.isFile() &&
      executable.uid === 0 &&
      !(executable.mode & 0o022) &&
      Boolean(executable.mode & 0o111),
    'trusted_browser_executable_required',
    503,
  );
  for (let directory = path.dirname(resolved); ; directory = path.dirname(directory)) {
    const info = fs.statSync(directory);
    assert(
      info.isDirectory() && info.uid === 0 && !(info.mode & 0o022),
      'trusted_browser_executable_required',
      503,
    );
    if (directory === '/') break;
  }
}
export function systemMounts(): string[] {
  const args = [
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    fs.realpathSync(process.execPath),
    '/runtime/node',
  ];
  if (fs.existsSync('/usr/lib64')) args.push('--symlink', 'usr/lib64', '/lib64');
  for (const file of ['/etc/fonts', '/etc/ssl', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf'])
    if (fs.existsSync(file)) args.push('--ro-bind', file, file);
  return args;
}
export function launchSandbox(
  config: Config,
  profile: string,
  run: string,
): ChildProcessWithoutNullStreams {
  assert(
    config.runtimeBundle && fs.existsSync(path.join(config.runtimeBundle, 'auth-worker.js')),
    'browser_runtime_not_built',
    503,
  );
  const executable = fs.realpathSync(
    config.browserExecutable ||
      (fs.existsSync('/opt/google/chrome/chrome')
        ? '/opt/google/chrome/chrome'
        : chromium.executablePath()),
  );
  assert(
    path.isAbsolute(executable) && fs.existsSync('/usr/bin/bwrap'),
    'browser_sandbox_unavailable',
    503,
  );
  const native = config.providerMode === 'native';
  if (native)
    for (const file of [executable, '/usr/bin/Xvfb', '/usr/bin/python3', '/usr/bin/setpriv'])
      trustedBrowserExecutable(file);
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop',
    'ALL',
    ...systemMounts(),
    '--ro-bind',
    config.runtimeBundle,
    '/app',
    '--ro-bind',
    path.resolve(config.runtimeBundle, '../../node_modules'),
    '/app/node_modules',
    '--ro-bind',
    path.dirname(executable),
    path.dirname(executable),
    '--bind',
    profile,
    '/profile',
    '--bind',
    run,
    '/run/dispatch',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    ...(native ? ['--setenv', 'DISPATCH_ISOLATED_BROWSER', '1'] : []),
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'XDG_CONFIG_HOME',
    '/tmp/config',
    '--setenv',
    'XDG_CACHE_HOME',
    '/tmp/cache',
    '--chdir',
    '/app',
    '/runtime/node',
    '--no-warnings',
    '--max-old-space-size=256',
    '/app/auth-worker.js',
    executable,
  ];
  return spawn(sandboxExecutable(config), args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
}
export function launchCollector(config: Config, run: string): ChildProcessWithoutNullStreams {
  assert(config.runtimeBundle, 'browser_runtime_not_built', 503);
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop',
    'ALL',
    ...systemMounts(),
    '--ro-bind',
    config.runtimeBundle,
    '/app',
    '--ro-bind',
    path.resolve(config.runtimeBundle, '../../node_modules'),
    '/app/node_modules',
    '--ro-bind',
    path.join(run, 'cdp.sock'),
    '/run/dispatch/cdp.sock',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--chdir',
    '/app',
    '/runtime/node',
    '--no-warnings',
    '--max-old-space-size=256',
    '/app/collection-worker.js',
  ];
  return spawn(sandboxExecutable(config), args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
}
