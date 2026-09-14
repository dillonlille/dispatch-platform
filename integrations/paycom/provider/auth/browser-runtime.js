'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveRootExecutable, trustedCommandPath } = require('./trusted-command-path');
const { ensurePrivateDirectory } = require('./storage-support');
const { bootId, processStartTicks } = require('./process-identity');

const START_TIMEOUT_MS = 15_000;
const PROFILE_ID_RE = /^[a-f0-9]{32}$/;
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const PROFILE_METADATA = 'dispatch-profile.json';
const PROCESS_MARKER = 'dispatch-browser.json';
const RUNTIME_ARTIFACTS = Object.freeze(['DevToolsActivePort', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']);
const PERSISTENT_PROVIDERS = Object.freeze(['paycom', 'amazon-logistics']);
const SAFE_CHROME_ARGS = Object.freeze([
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,AutofillEnableAccountWalletStorage',
  '--disable-save-password-bubble',
  '--password-store=basic',
  '--disable-dev-shm-usage',
]);

class BrowserError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function safeChromeExecutable(value) {
  const resolved = resolveRootExecutable(value, []);
  if (!resolved) throw new BrowserError('browser_unavailable');
  return resolved;
}

function discoverBrowserExecutable(configured, names) {
  const resolved = resolveRootExecutable(configured, names);
  if (!resolved) throw new BrowserError('browser_unavailable');
  return resolved;
}

function safeEndpoint(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new BrowserError('browser_start_failed');
  return `http://127.0.0.1:${port}`;
}

function cancelled(signal) {
  if (signal?.aborted) throw new BrowserError('acquisition_cancelled');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    try { cancelled(signal); } catch (error) { reject(error); return; }
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function aborted() { cleanup(); reject(new BrowserError('acquisition_cancelled')); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid) && Date.now() < deadline) await delay(25);
  return !processGroupAlive(pid);
}

async function waitForDevTools(file, child, timeoutMs = START_TIMEOUT_MS, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    cancelled(signal);
    if (child.__dispatchSpawnError || child.exitCode !== null || child.signalCode !== null) throw new BrowserError('browser_start_failed');
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1 || info.size > 1024) {
        throw new BrowserError('unsafe_browser');
      }
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      const port = Number(lines[0]);
      if (lines.length !== 2 || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(lines[1])) throw new BrowserError('browser_start_failed');
      return { endpoint: safeEndpoint(port), browserWebSocketPath: lines[1] };
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      if (error?.code !== 'ENOENT') throw new BrowserError('browser_start_failed');
    }
    await delay(50, signal);
  }
  throw new BrowserError('browser_start_failed');
}

function validateIdentity(provider, profile) {
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider) || typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new BrowserError('unsafe_browser');
  }
}

function persistentProfileId(provider, profile) {
  validateIdentity(provider, profile);
  return crypto.createHash('sha256').update(`${provider}\0${profile}`).digest('hex').slice(0, 32);
}

function privateDirectory(directory) {
  let info;
  try { info = fs.lstatSync(directory); } catch { throw new BrowserError('unsafe_browser'); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || (info.mode & 0o077) !== 0
      || fs.realpathSync(directory) !== directory) throw new BrowserError('unsafe_browser');
}

function privateFile(file, maximum = 4096) {
  let info;
  try { info = fs.lstatSync(file); } catch { throw new BrowserError('unsafe_browser'); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || (info.mode & 0o177) !== 0 || info.size > maximum || fs.realpathSync(file) !== file) throw new BrowserError('unsafe_browser');
}

function profileLayout(stateRoot, provider, profile) {
  validateIdentity(provider, profile);
  const id = persistentProfileId(provider, profile);
  const directory = path.join(path.resolve(stateRoot), id);
  return { id, directory, profileDirectory: path.join(directory, 'chrome'), metadata: path.join(directory, PROFILE_METADATA), marker: path.join(directory, PROCESS_MARKER), persistent: true };
}

function parseProfileMetadata(file, expectedId = null) {
  privateFile(file, 1024);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new BrowserError('unsafe_browser'); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'kind,profile,provider,version'
      || value.version !== 1 || value.kind !== 'persistent') throw new BrowserError('unsafe_browser');
  validateIdentity(value.provider, value.profile);
  if (expectedId !== null && persistentProfileId(value.provider, value.profile) !== expectedId) throw new BrowserError('unsafe_browser');
  return value;
}

function validatePersistentLayout(stateRoot, name, expected = null) {
  if (!PROFILE_ID_RE.test(name)) throw new BrowserError('unsafe_browser');
  const directory = path.join(path.resolve(stateRoot), name);
  privateDirectory(directory);
  const metadata = parseProfileMetadata(path.join(directory, PROFILE_METADATA), name);
  if (expected && (metadata.provider !== expected.provider || metadata.profile !== expected.profile)) throw new BrowserError('unsafe_browser');
  const profileDirectory = path.join(directory, 'chrome');
  privateDirectory(profileDirectory);
  return { id: name, directory, profileDirectory, metadata: path.join(directory, PROFILE_METADATA), marker: path.join(directory, PROCESS_MARKER), persistent: true };
}

function ensurePersistentProfile(stateRoot, provider, profile) {
  stateRoot = path.resolve(stateRoot);
  ensurePrivateDirectory(stateRoot);
  const layout = profileLayout(stateRoot, provider, profile);
  if (fs.existsSync(layout.directory)) return validatePersistentLayout(stateRoot, layout.id, { provider, profile });
  fs.mkdirSync(layout.directory, { mode: 0o700 });
  try {
    fs.writeFileSync(layout.metadata, `${JSON.stringify({ version: 1, kind: 'persistent', provider, profile })}\n`, { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(layout.profileDirectory, { mode: 0o700 });
    return validatePersistentLayout(stateRoot, layout.id, { provider, profile });
  } catch (error) {
    fs.rmSync(layout.directory, { recursive: true, force: true });
    throw error instanceof BrowserError ? error : new BrowserError('unsafe_browser');
  }
}

function readProcessMarker(file) {
  if (!fs.existsSync(file)) return null;
  privateFile(file);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new BrowserError('unsafe_browser'); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new BrowserError('unsafe_browser');
  if (Object.keys(value).sort().join(',') === 'brokerPid,browserPid,version' && value.version === 1
      && Number.isInteger(value.browserPid) && value.browserPid >= 2 && Number.isInteger(value.brokerPid) && value.brokerPid >= 2) {
    return { ...value, legacy: true };
  }
  if (Object.keys(value).sort().join(',') !== 'bootId,brokerPid,brokerStartTicks,browserPid,browserStartTicks,executable,version'
      || value.version !== 2 || !Number.isInteger(value.browserPid) || value.browserPid < 2
      || !Number.isInteger(value.brokerPid) || value.brokerPid < 2 || !/^[0-9a-f-]{36}$/.test(value.bootId)
      || !/^\d+$/.test(value.browserStartTicks) || !/^\d+$/.test(value.brokerStartTicks)
      || typeof value.executable !== 'string' || path.resolve(value.executable) !== value.executable) {
    throw new BrowserError('unsafe_browser');
  }
  return value;
}

function processArguments(pid) {
  try {
    const proc = fs.lstatSync(`/proc/${pid}`);
    if (!proc.isDirectory() || proc.uid !== process.geteuid()) return null;
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  } catch { return null; }
}

function profileProcessPids(profileDirectory) {
  const argument = `--user-data-dir=${profileDirectory}`;
  const pids = [];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { throw new BrowserError('unsafe_browser'); }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const args = processArguments(pid);
    if (args?.includes(argument)) pids.push(pid);
  }
  return pids;
}

function markerOwnsBrowser(marker, profileDirectory, expectedExecutable = null) {
  if (!marker || marker.legacy === true || marker.bootId !== bootId()
      || expectedExecutable && marker.executable !== expectedExecutable
      || processStartTicks(marker.browserPid) !== marker.browserStartTicks) return false;
  const args = processArguments(marker.browserPid);
  return Boolean(args?.includes(marker.executable) && args.includes(`--user-data-dir=${profileDirectory}`));
}

function clearRuntimeArtifacts(profileDirectory) {
  privateDirectory(profileDirectory);
  if (profileProcessPids(profileDirectory).length) throw new BrowserError('browser_profile_busy');
  // Resume session cookies without replaying a previous login/PIN form or
  // opening stale application tabs. Cookies and other profile storage remain.
  const defaultProfile = path.join(profileDirectory, 'Default');
  let defaultInfo;
  try { defaultInfo = fs.lstatSync(defaultProfile); }
  catch (error) { if (error?.code !== 'ENOENT') throw new BrowserError('unsafe_browser'); }
  if (defaultInfo) {
    privateDirectory(defaultProfile);
    for (const name of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
      fs.rmSync(path.join(defaultProfile, name), { recursive: true, force: true });
    }
  }
  // Fontconfig may create these two cache directories with 0755 despite the
  // private profile. Restrict only recognized, owned directories; never follow
  // a link, rewrite cached files, or normalize an arbitrary profile tree.
  let cache = profileDirectory;
  for (const name of ['.cache', 'fontconfig']) {
    cache = path.join(cache, name);
    let fd;
    try {
      fd = fs.openSync(cache, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const info = fs.fstatSync(fd);
      if (!info.isDirectory() || info.uid !== process.geteuid() || ![0o700, 0o755].includes(info.mode & 0o7777)
          || fs.realpathSync(cache) !== cache) throw new BrowserError('unsafe_browser');
      if ((info.mode & 0o7777) === 0o755) fs.fchmodSync(fd, 0o700);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error instanceof BrowserError ? error : new BrowserError('unsafe_browser');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  for (const name of RUNTIME_ARTIFACTS) {
    const target = path.join(profileDirectory, name);
    if (!fs.existsSync(target) && !fs.lstatSync(profileDirectory).isDirectory()) throw new BrowserError('unsafe_browser');
    try { fs.rmSync(target, { force: true }); } catch { throw new BrowserError('browser_cleanup_failed'); }
  }
  // Chrome uses the profile as HOME. PulseAudio can leave a machine-specific
  // runtime symlink here after Chrome exits, which makes a sealed backup fail.
  // Walk only private real directories and unlink the runtime links themselves.
  let directory = profileDirectory;
  for (const name of ['.config', 'pulse']) {
    directory = path.join(directory, name);
    try { fs.lstatSync(directory); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new BrowserError('browser_cleanup_failed');
    }
    privateDirectory(directory);
  }
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{32}-runtime$/.test(name)) continue;
    const target = path.join(directory, name);
    const info = fs.lstatSync(target);
    if (!info.isSymbolicLink()) continue;
    if (info.uid !== process.geteuid()) throw new BrowserError('unsafe_browser');
    try { fs.unlinkSync(target); } catch { throw new BrowserError('browser_cleanup_failed'); }
  }
}

function removePersistentProfile(stateRoot, provider, profile) {
  stateRoot = path.resolve(stateRoot);
  validateIdentity(provider, profile);
  if (!fs.existsSync(stateRoot)) return false;
  privateDirectory(stateRoot);
  const expected = profileLayout(stateRoot, provider, profile);
  if (!fs.existsSync(expected.directory)) return false;
  const layout = validatePersistentLayout(stateRoot, expected.id, { provider, profile });
  const marker = readProcessMarker(layout.marker);
  if (profileProcessPids(layout.profileDirectory).length > 0
      || marker && markerOwnsBrowser(marker, layout.profileDirectory)) throw new BrowserError('browser_profile_busy');
  fs.rmSync(layout.directory, { recursive: true, force: false });
  return true;
}

function chromeArguments({ persistent, profileDirectory, headless, directoryNetwork = false }) {
  if (typeof persistent !== 'boolean' || typeof headless !== 'boolean' || typeof profileDirectory !== 'string'
      || path.resolve(profileDirectory) !== profileDirectory) throw new BrowserError('unsafe_browser');
  return [
    ...SAFE_CHROME_ARGS,
    ...(directoryNetwork ? ['--proxy-server=http://127.0.0.1:17891', '--proxy-bypass-list=<-loopback>',
      '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] : []),
    ...(persistent ? ['--restore-last-session'] : ['--incognito']),
    ...(headless ? ['--headless=new'] : []),
    '--window-size=1440,1000',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ];
}

class ChromeBrowserRuntime {
  constructor({
    stateRoot,
    executable = process.env.DISPATCH_CHROME_EXECUTABLE,
    headless = true,
    spawnImpl = spawn,
    startTimeoutMs = START_TIMEOUT_MS,
    launcher = process.env.DISPATCH_BROWSER_LAUNCHER,
    persistentProviders = PERSISTENT_PROVIDERS,
    transport = ['native_service_v1', 'directory_service_v1'].includes(process.env.DISPATCH_RUNTIME_BACKEND) ? 'pipe' : 'tcp',
    socketRoot = process.env.DISPATCH_RUNTIME_ROOT,
    directoryNetwork = process.env.DISPATCH_RUNTIME_BACKEND === 'directory_service_v1',
  }) {
    this.stateRoot = path.resolve(stateRoot);
    this.executable = discoverBrowserExecutable(executable, ['google-chrome', 'chromium', 'chromium-browser']);
    this.launcher = discoverBrowserExecutable(launcher, ['setpriv']);
    this.commandPath = trustedCommandPath();
    this.headless = headless;
    this.spawnImpl = spawnImpl;
    this.startTimeoutMs = startTimeoutMs;
    if (!Array.isArray(persistentProviders) || persistentProviders.some(value => typeof value !== 'string' || !PROVIDER_RE.test(value))) throw new BrowserError('unsafe_browser');
    this.persistentProviders = new Set(persistentProviders);
    if (!['pipe', 'tcp'].includes(transport)) throw new BrowserError('unsafe_browser');
    this.transport = transport;
    this.socketRoot = socketRoot;
    if (typeof directoryNetwork !== 'boolean') throw new BrowserError('unsafe_browser');
    this.directoryNetwork = directoryNetwork;
  }

  async reconcile() {
    ensurePrivateDirectory(this.stateRoot);
    for (const name of fs.readdirSync(this.stateRoot)) {
      if (!PROFILE_ID_RE.test(name)) throw new BrowserError('unsafe_browser');
      const directory = path.join(this.stateRoot, name);
      privateDirectory(directory);
      const marker = readProcessMarker(path.join(directory, PROCESS_MARKER));
      const metadata = path.join(directory, PROFILE_METADATA);
      const profileDirectory = fs.existsSync(metadata) ? path.join(directory, 'chrome') : directory;
      const active = profileProcessPids(profileDirectory);
      if (active.length > 0 || marker && markerOwnsBrowser(marker, profileDirectory, this.executable)) {
        throw new BrowserError('browser_profile_busy');
      }
      if (!fs.existsSync(metadata)) {
        fs.rmSync(directory, { recursive: true, force: true });
        continue;
      }
      const layout = validatePersistentLayout(this.stateRoot, name);
      try { fs.rmSync(layout.marker, { force: true }); } catch { throw new BrowserError('browser_cleanup_failed'); }
      clearRuntimeArtifacts(layout.profileDirectory);
    }
  }

  async launch({ signal, profile = null, provider = null, nativeInput = false } = {}) {
    cancelled(signal);
    if (typeof nativeInput !== 'boolean') throw new BrowserError('unsafe_browser');
    ensurePrivateDirectory(this.stateRoot);
    const persistent = typeof provider === 'string' && this.persistentProviders.has(provider);
    let layout;
    if (persistent) {
      layout = ensurePersistentProfile(this.stateRoot, provider, profile);
      const marker = readProcessMarker(layout.marker);
      if (profileProcessPids(layout.profileDirectory).length > 0
          || marker && markerOwnsBrowser(marker, layout.profileDirectory, this.executable)) throw new BrowserError('browser_profile_busy');
      if (marker) try { fs.rmSync(layout.marker, { force: true }); } catch { throw new BrowserError('browser_cleanup_failed'); }
      clearRuntimeArtifacts(layout.profileDirectory);
    } else {
      const id = crypto.randomBytes(16).toString('hex');
      const directory = path.join(this.stateRoot, id);
      fs.mkdirSync(directory, { mode: 0o700 });
      layout = { id, directory, profileDirectory: directory, marker: path.join(directory, PROCESS_MARKER), persistent: false };
    }
    const transport = nativeInput ? 'tcp' : this.transport;
    const args = chromeArguments({ persistent, profileDirectory: layout.profileDirectory, headless: nativeInput ? false : this.headless,
      directoryNetwork: this.directoryNetwork });
    if (transport === 'pipe') {
      for (let index = args.length - 1; index >= 0; index--) if (args[index].startsWith('--remote-debugging-')) args.splice(index, 1);
      args.unshift('--remote-debugging-pipe');
    }
    let child;
    let abortStartup;
    let privateTransport;
    let window;
    let windowPort;
    try {
      if (nativeInput) {
        const { createNativeWindow, reservePort } = require('./native-window');
        window = await createNativeWindow({ directory: layout.directory, launcher: this.launcher, signal });
        windowPort = await reservePort();
        args[args.indexOf('--remote-debugging-port=0')] = `--remote-debugging-port=${windowPort}`;
      }
      cancelled(signal);
      child = this.spawnImpl(this.launcher, ['--pdeathsig', 'KILL', '--', this.executable, ...args], {
        detached: true,
        stdio: transport === 'pipe' ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
        env: { PATH: this.commandPath, HOME: layout.profileDirectory, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
          ...(window ? { DISPLAY: window.env.DISPLAY, XAUTHORITY: window.env.XAUTHORITY }
            : this.headless ? {} : { DISPLAY: process.env.DISPLAY || '' }) },
      });
      child.__dispatchSpawnError = null;
      child.on('error', error => { child.__dispatchSpawnError = error; });
      const browserStartTicks = processStartTicks(child.pid);
      const brokerStartTicks = processStartTicks(process.pid);
      if (!browserStartTicks || !brokerStartTicks) throw new BrowserError('browser_start_failed');
      fs.writeFileSync(layout.marker, `${JSON.stringify({
        version: 2,
        brokerPid: process.pid,
        browserPid: child.pid,
        bootId: bootId(),
        brokerStartTicks,
        browserStartTicks,
        executable: this.executable,
      })}\n`, { mode: 0o600, flag: 'wx' });
      abortStartup = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
      signal?.addEventListener('abort', abortStartup, { once: true });
      let active;
      if (transport === 'pipe') {
        if (!this.socketRoot) throw new BrowserError('unsafe_browser');
        ensurePrivateDirectory(this.socketRoot);
        privateTransport = await require('./cdp-pipe').servePipe({ input: child.stdio[3], output: child.stdio[4],
          socketPath: path.join(this.socketRoot, `cdp-${crypto.randomBytes(8).toString('hex')}.sock`),
          startupTimeoutMs: this.startTimeoutMs });
        active = privateTransport;
      } else if (window) active = await require('./native-window').waitForWindowBrowser(windowPort, child, this.startTimeoutMs, signal);
      else active = await waitForDevTools(path.join(layout.profileDirectory, 'DevToolsActivePort'), child, this.startTimeoutMs, signal);
      if (transport !== 'pipe' && this.socketRoot) {
        ensurePrivateDirectory(this.socketRoot);
        privateTransport = await require('./cdp-websocket-pipe').serveWebSocket({
          url: active.browserWebSocketUrl || `ws://127.0.0.1:${new URL(active.endpoint).port}${active.browserWebSocketPath}`,
          socketPath: path.join(this.socketRoot, `cdp-${crypto.randomBytes(8).toString('hex')}.sock`),
          startupTimeoutMs: this.startTimeoutMs });
      }
      cancelled(signal);
      signal?.removeEventListener('abort', abortStartup);
      let closed = false;
      let closing = null;
      return {
        id: layout.id,
        endpoint: active.endpoint,
        pluginEndpoint: privateTransport?.endpoint || active.endpoint,
        browserWebSocketUrl: active.browserWebSocketUrl || `ws://127.0.0.1:${new URL(active.endpoint).port}${active.browserWebSocketPath}`,
        profileDirectory: layout.profileDirectory,
        persistent,
        pid: child.pid,
        ...(window ? { nativeInput: window.input } : {}),
        isAlive() { return !closed && (!window || window.isAlive()) && child.exitCode === null && child.signalCode === null && processGroupAlive(child.pid); },
        onExit(listener) {
          if (typeof listener !== 'function') throw new TypeError('listener must be a function');
          child.on('exit', listener);
          const removeDisplayListener = window?.onExit(listener);
          return () => { child.off('exit', listener); removeDisplayListener?.(); };
        },
        async close() {
          if (closed) return;
          if (closing) return closing;
          closing = (async () => {
            // Let persistent profiles flush cookies before terminating
            // Chrome. An unresponsive browser still uses the bounded fallback.
            if (persistent && child.exitCode === null && child.signalCode === null) {
              let shutdownConnection;
              try {
                const { CdpConnection } = require('./cdp');
                const url = active.browserWebSocketUrl || `ws://127.0.0.1:${new URL(active.endpoint).port}${active.browserWebSocketPath}`;
                shutdownConnection = await CdpConnection.connect(url, { openTimeoutMs: 1_000, commandTimeoutMs: 2_000 });
                await shutdownConnection.command('Browser.close');
              } catch {} finally { shutdownConnection?.close(); }
              await waitForGroupExit(child.pid, 3_000);
            }
            privateTransport?.close();
            try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw new BrowserError('browser_cleanup_failed'); }
            if (!(await waitForGroupExit(child.pid, 2_000))) {
              try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw new BrowserError('browser_cleanup_failed'); }
              if (!(await waitForGroupExit(child.pid, 2_000))) throw new BrowserError('browser_cleanup_failed');
            }
            await window?.close();
            try { fs.rmSync(layout.marker, { force: true }); } catch { throw new BrowserError('browser_cleanup_failed'); }
            if (persistent) clearRuntimeArtifacts(layout.profileDirectory);
            else fs.rmSync(layout.directory, { recursive: true, force: true });
            closed = true;
          })();
          try { await closing; } finally { closing = null; }
        },
      };
    } catch (error) {
      privateTransport?.close();
      signal?.removeEventListener('abort', abortStartup);
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        await waitForGroupExit(child.pid, 2_000).catch(() => false);
      }
      await window?.close();
      try { fs.rmSync(layout.marker, { force: true }); } catch {}
      if (layout.persistent) {
        try { clearRuntimeArtifacts(layout.profileDirectory); } catch {}
      } else fs.rmSync(layout.directory, { recursive: true, force: true });
      throw error instanceof BrowserError ? error : new BrowserError(
        ['acquisition_cancelled', 'browser_unavailable', 'browser_cleanup_failed'].includes(error?.code)
          ? error.code : 'browser_start_failed');
    }
  }
}

module.exports = {
  ChromeBrowserRuntime, BrowserError, SAFE_CHROME_ARGS, PROFILE_METADATA, PROCESS_MARKER, RUNTIME_ARTIFACTS,
  safeChromeExecutable, waitForDevTools, processGroupAlive, waitForGroupExit, persistentProfileId,
  profileLayout, ensurePersistentProfile, removePersistentProfile, clearRuntimeArtifacts, chromeArguments,
  readProcessMarker, profileProcessPids, markerOwnsBrowser, PERSISTENT_PROVIDERS,
};
