'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { platformPaths, directory } = require('../../shared/paths/platform-paths');
const { inspectBrowser } = require('./browser-artifact');
const { inspectDsp } = require('../storage/storage');
const { CODE_ROOT, NODE_ROOT, BROWSER_ROOT, BRIDGE_ROOT, runtimeEnvironment, storageMounts } = require('./runtime-layout');

const BACKEND = 'directory_service_v1';
const SOURCE_DIRECTORIES = Object.freeze(['bin', 'runtime', 'plugins', 'compatibility', 'node_modules']);

function fail() { throw new Error('directory_service_invalid'); }
function safePath(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value)
      || path.resolve(value) !== value || fs.realpathSync(value) !== value) fail();
  return value;
}

function environment(id) {
  const selected = runtimeEnvironment(id);
  const root = path.dirname(selected.DISPATCH_DATA_ROOT);
  return Object.freeze({ ...selected, HOME: '/tmp/dispatch-home', PATH: `${NODE_ROOT}:/usr/bin:/bin`,
    DISPATCH_RUNTIME_BACKEND: BACKEND,
    DISPATCH_PLUGIN_BACKEND: 'core_v1',
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: `${BRIDGE_ROOT}/runtime-agent-hub.sock`,
    DISPATCH_RUNTIME_AGENT_TOKEN_FILE: `${root}/secrets/runtime-agent/registration-token`,
    DISPATCH_RUNTIME_AGENT_STATUS_SOCKET: `${root}/run/runtime-agent-status.sock`,
    DISPATCH_CHROME_EXECUTABLE: `${BROWSER_ROOT}/chrome`,
  });
}

// Produces a local service specification; never installs a unit, invokes sudo,
// or changes an account. The caller controls the privileged activation boundary.
function serviceSpec(paths, id, { nodeRoot, browserRoot, script = 'runtime/supervisor/src/supervisor.js', scriptArguments = [], sourceRoot = null } = {}) {
  if (process.geteuid() === 0) fail();
  paths = platformPaths(paths.platformRoot);
  const dsp = inspectDsp(paths, id);
  const codeRoot = sourceRoot || require('../releases/runtime').runtimeSource(paths,id);
  const codeDirectories = fs.existsSync(path.join(codeRoot,'node_modules')) ? SOURCE_DIRECTORIES : ['bin','runtime','plugins','compatibility','shared','sdk','core','host'];
  for (const selected of [codeRoot, dsp.root, nodeRoot, browserRoot]) safePath(selected);
  directory(nodeRoot);
  if (!nodeRoot.startsWith(paths.local + '/')) fail();
  if (fs.readdirSync(nodeRoot).sort().join(',') !== 'node,tini') fail();
  for (const name of ['node', 'tini']) {
    const tool = fs.lstatSync(path.join(nodeRoot, name));
    if (!tool.isFile() || tool.isSymbolicLink() || tool.uid !== process.geteuid() || tool.mode & 0o022
        || !(tool.mode & 0o111)) fail();
  }
  // Validate the sealed private bundle on the host. Inside the namespace the
  // existing rootExecutable check still validates Chrome and every ancestor.
  inspectBrowser(paths, browserRoot);
  const rootDirectory = path.join(dsp.root, '.service-root');
  const codeView = path.join(dsp.root, '.code-view');
  const bridgeDirectory = path.join(dsp.root, '.control');
  const mounts = storageMounts(dsp);
  const root = fs.lstatSync(safePath(rootDirectory));
  if (!root.isDirectory() || root.uid !== 0 || root.mode & 0o022) fail();
  for (const selected of [codeView, path.join(codeView, 'dependencies'), path.join(codeView, 'dependencies/browser')]) {
    const info = fs.lstatSync(safePath(selected));
    if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o022) fail();
  }
  for (const name of codeDirectories) directory(safePath(path.join(codeRoot, name)));
  directory(bridgeDirectory);
  if (fs.statSync(bridgeDirectory).mode & 0o077) fail();
  if (typeof script !== 'string' || !/^[A-Za-z0-9_./-]+\.js$/.test(script)
      || path.isAbsolute(script) || path.normalize(script) !== script || script.startsWith('..')
      || !SOURCE_DIRECTORIES.includes(script.split('/')[0])
      || !Array.isArray(scriptArguments) || scriptArguments.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) fail();
  const source = path.join(codeRoot, script);
  if (safePath(source) !== source || !fs.statSync(source).isFile()) fail();
  const guestRoot = mounts[0].target;
  const properties = {
    Type: 'exec', User: String(process.geteuid()), Group: String(process.getegid()), UMask: '0077',
    RootDirectory: rootDirectory, MountAPIVFS: 'yes', WorkingDirectory: CODE_ROOT,
    // A root-owned view preserves the browser's trusted ancestor checks and its
    // canonical AppArmor path while application source stays operator-owned.
    BindReadOnlyPaths: [`/usr:/usr`, `${codeView}:${CODE_ROOT}`,
      ...codeDirectories.map(name => `${codeRoot}/${name}:${CODE_ROOT}/${name}`),
      ...mounts.filter(mount => path.basename(mount.source) === 'plugins').map(mount => `${mount.source}:${mount.target}`),
      `${nodeRoot}:${NODE_ROOT}`, `${browserRoot}:${BROWSER_ROOT}`, `${bridgeDirectory}:${BRIDGE_ROOT}`].join(' '),
    // Bind only storage, never the parent containing the host control socket or
    // service root. The small view root preserves the same filesystem identity
    // required by the runtime's existing storage validation.
    BindPaths: mounts.filter(mount => path.basename(mount.source) !== 'plugins').map(mount => `${mount.source}:${mount.target}`).join(' '),
    InaccessiblePaths: '-+/run/docker.sock -+/run/podman -+/run/containerd '
      + ['data/auth-broker', 'secrets/auth-broker', 'state/auth-broker'].map(name => `-+${guestRoot}/${name}`).join(' '),
    TemporaryFileSystem: '/tmp:rw,noexec,nosuid,nodev,size=512M,mode=1777 /dev/shm:rw,noexec,nosuid,nodev,size=512M,mode=1777',
    ReadWritePaths: `+${guestRoot}`,
    NoExecPaths: [...mounts.map(mount => `+${mount.target}`), `+${BRIDGE_ROOT}`].join(' '),
    ProtectSystem: 'strict', ProtectHome: 'yes', PrivateMounts: 'yes', PrivatePIDs: 'yes', PrivateIPC: 'yes',
    PrivateNetwork: 'yes', PrivateUsers: 'yes', PrivateDevices: 'yes', ProtectProc: 'invisible',
    NoNewPrivileges: 'yes', CapabilityBoundingSet: '', AmbientCapabilities: '',
    ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectControlGroups: 'yes',
    RestrictSUIDSGID: 'yes', LockPersonality: 'yes', RestrictRealtime: 'yes',
    RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    CPUQuota: '200%', MemoryMax: '4G', TasksMax: '512', OOMPolicy: 'stop',
    // The Collection Manager fences writers with a 60-second durable lease.
    // After an unclean exit allow it to expire; never delete the lease to force
    // a restart or exhaust the restart limit while the old lease is valid.
    Restart: 'on-failure', RestartSec: '65', StartLimitIntervalSec: '300', StartLimitBurst: '3',
    KillMode: 'mixed', TimeoutStopSec: '30',
  };
  return Object.freeze({ id, backend: BACKEND, properties: Object.freeze(properties), environment: environment(id),
    // Namespace PID 1 must reap orphaned browser subprocesses. Node alone does
    // not do that; leaving zombies makes browser shutdown and restart fail.
    command: Object.freeze([`${NODE_ROOT}/tini`, '-g', '--', `${NODE_ROOT}/node`, '--no-warnings', `${CODE_ROOT}/${script}`, ...scriptArguments]) });
}

module.exports = { BACKEND, NODE_ROOT, BROWSER_ROOT, CODE_ROOT, BRIDGE_ROOT, SOURCE_DIRECTORIES, environment, serviceSpec };
