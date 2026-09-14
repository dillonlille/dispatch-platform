'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { privateJson } = require('./storage');
const { assertExternalRuntimePaths } = require('./paths');
const { SOLVE_MS, fail } = require('./protocol');

function loadConfiguration(paths) {
  let value;
  try { value = privateJson(path.join(paths.local, 'config/browser-assistance.json'), process.geteuid()); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (value?.enabled === false) return null;
  if (!value || Object.keys(value).sort().join(',') !== 'agentBrowserDirectory,concurrency,enabled,hermesDirectory,maximum,profileDirectory,pythonExecutable,version'
      || value.version !== 1 || value.enabled !== true) fail();
  const names = ['profileDirectory', 'hermesDirectory', 'pythonExecutable', 'agentBrowserDirectory'];
  assertExternalRuntimePaths(paths.live, names.map(name => value[name]));
  for (const name of names) {
    const file = value[name];
    if (typeof file !== 'string' || !path.isAbsolute(file) || name !== 'pythonExecutable' && fs.realpathSync(file) !== file) fail();
    const stat = fs.statSync(file);
    if (stat.mode & 0o002 || ![0, process.geteuid()].includes(stat.uid)
        || (name === 'pythonExecutable' ? !stat.isFile() || !(stat.mode & 0o111) : !stat.isDirectory())) fail();
  }
  if (path.basename(path.dirname(value.profileDirectory)) !== 'profiles') fail();
  const profile = fs.statSync(value.profileDirectory);
  if (profile.uid !== process.geteuid() || profile.mode & 0o077) fail();
  for (const name of ['config.yaml', '.env', 'auth.json']) {
    const file = path.join(value.profileDirectory, name);
    if (!fs.existsSync(file) && name !== 'config.yaml') continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || stat.mode & 0o077) fail();
  }
  return Object.freeze(value);
}

function sessionProcesses(temporary) {
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const directory = `/proc/${name}`;
      if (fs.statSync(directory).uid !== process.geteuid()) continue;
      const environment = fs.readFileSync(directory + '/environ', 'utf8').split('\0');
      if (environment.some(value => value === `TMPDIR=${temporary}`
          || value.startsWith(`AGENT_BROWSER_SOCKET_DIR=${temporary}/`))) found.push(Number(name));
    } catch {}
  }
  return found;
}
async function cleanupSession(home, temporary) {
  const kill = signal => { for (const pid of sessionProcesses(temporary)) { try { process.kill(pid, signal); } catch {} } };
  kill('SIGTERM');
  for (let index = 0; index < 20 && sessionProcesses(temporary).length; index++) await new Promise(resolve => setTimeout(resolve, 50));
  kill('SIGKILL');
  for (let index = 0; index < 20 && sessionProcesses(temporary).length; index++) await new Promise(resolve => setTimeout(resolve, 50));
  if (sessionProcesses(temporary).length) throw new Error('assistance_cleanup_failed');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(temporary, { recursive: true, force: true });
}
async function reapSessions(configuration) {
  const parent = path.dirname(configuration.profileDirectory);
  for (const name of fs.readdirSync(parent)) {
    if (!/^dispatch-assistance-[a-f0-9]{32}$/.test(name)) continue;
    const home = path.join(parent, name);
    let marker;
    try { marker = privateJson(path.join(home, 'dispatch-owner.json'), process.geteuid()); }
    catch { continue; }
    // PID identity includes its kernel start time, so reuse cannot protect an orphan.
    let alive = false;
    try { alive = fs.readFileSync(`/proc/${marker.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] === marker.started; } catch {}
    if (alive) continue;
    if (typeof marker.temporary !== 'string' || path.dirname(marker.temporary) !== os.tmpdir()
        || !/^dispatch-assist-[A-Za-z0-9]{6}$/.test(path.basename(marker.temporary))) continue;
    for (const file of [home, marker.temporary]) {
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || stat.mode & 0o077) fail();
    }
    await cleanupSession(home, marker.temporary);
  }
}
async function runHermes(configuration, endpoint, { signal, spawnImpl = spawn, timeoutMs = SOLVE_MS, runtimeKey = null } = {}) {
  if (runtimeKey !== null) require('./paths').validateDspId(runtimeKey);
  const sessionId = 'dispatch-assistance-' + crypto.randomBytes(16).toString('hex');
  const home = path.join(path.dirname(configuration.profileDirectory), sessionId);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-assist-'));
  fs.chmodSync(temporary, 0o700); fs.mkdirSync(home, { mode: 0o700 });
  const started = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  fs.writeFileSync(path.join(home, 'dispatch-owner.json'), JSON.stringify({ pid: process.pid, started, temporary, runtimeKey }), { mode: 0o600 });
  try { return await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('assistance_cancelled'));
    let child, timer, killTimer, failure = null, settled = false;
    const kill = kind => { try { process.kill(-child.pid, kind); } catch { try { child.kill(kind); } catch {} } };
    const stop = reason => {
      if (failure || settled) return;
      failure = new Error(reason); kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    const abort = () => stop('assistance_cancelled');
    const finish = code => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      // agent-browser may daemonize; normal cleanup detaches it, and its own idle
      // deadline bounds remnants after SIGKILL. Revocation closes browser access.
      if (failure || code !== 0) reject(failure || new Error('assistance_failed'));
      else {
        let summary = null;
        try {
          const value = JSON.parse(fs.readFileSync(path.join(temporary, 'dispatch-result.json'), 'utf8'));
          if (typeof value.completed === 'boolean' && Number.isInteger(value.toolErrors) && value.toolErrors >= 0
              && value.toolCounts && Object.entries(value.toolCounts).every(([name, count]) => /^browser_[a-z_]+$/.test(name) && Number.isInteger(count) && count >= 0)) {
            summary = { completed: value.completed, toolErrors: value.toolErrors, toolCounts: value.toolCounts };
          }
        } catch {}
        resolve(summary);
      }
    };
    try {
      child = spawnImpl(configuration.pythonExecutable, [path.join(__dirname, 'hermes-session.py')], {
        detached: true, cwd: configuration.hermesDirectory, stdio: ['pipe', 'ignore', 'ignore'],
        env: { HOME: process.env.HOME, TMPDIR: temporary, PATH: `${configuration.agentBrowserDirectory}:/usr/bin:/bin`,
          LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
      });
      child.on('error', () => finish(1)); child.on('close', finish);
      child.stdin.on('error', () => stop('assistance_failed'));
      child.stdin.end(JSON.stringify({ profileDirectory: configuration.profileDirectory, hermesDirectory: configuration.hermesDirectory,
        endpoint, sessionId, solveSeconds: Math.floor(timeoutMs / 1000) }) + '\n');
      timer = setTimeout(() => stop('assistance_timeout'), timeoutMs + 5000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch { finish(1); }
  }); } finally { await cleanupSession(home, temporary); }
}
async function eraseDspSessions(configuration, runtimeKey) {
  if (!configuration) return;
  require('./paths').validateDspId(runtimeKey);
  const parent = path.dirname(configuration.profileDirectory);
  for (const name of fs.readdirSync(parent)) {
    if (!/^dispatch-assistance-[a-f0-9]{32}$/.test(name)) continue;
    const home = path.join(parent, name), marker = privateJson(path.join(home, 'dispatch-owner.json'), process.geteuid(), true);
    if (marker?.runtimeKey !== runtimeKey) continue;
    if (typeof marker.temporary !== 'string' || path.dirname(marker.temporary) !== os.tmpdir()
        || !/^dispatch-assist-[A-Za-z0-9]{6}$/.test(path.basename(marker.temporary))) fail();
    for (const file of [home, marker.temporary]) if (fs.existsSync(file)) {
      const info = fs.lstatSync(file);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.mode & 0o077) fail();
    }
    await cleanupSession(home, marker.temporary);
  }
}
module.exports = { loadConfiguration, runHermes, sessionProcesses, cleanupSession, reapSessions, eraseDspSessions };
