import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chromium } from 'playwright';
import type { Config } from '../config.js';
import { assert } from '../../shared/errors.js';
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
  return spawn('/usr/bin/bwrap', args, {
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
  return spawn('/usr/bin/bwrap', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
}
