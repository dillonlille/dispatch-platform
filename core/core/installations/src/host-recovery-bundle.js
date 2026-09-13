'use strict';
// Root-only recovery inventory. Account names, service names and root paths are
// derived from trusted host configuration, never from an API-supplied path.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const capsule = require('./recovery-capsule');
const { HOST_TENANT_ROOT, opaqueRuntimeSuffix, hostAccountName } = require('../../runtime-host-identity');
const fail = () => { throw Error('host_recovery_unavailable'); };
const SHARED_UNITS = ['dispatch-dashboard.service', 'dispatch-installation-reconcile.service', 'dispatch-installation-reconcile.timer',
  'dispatch-platform-update.service', 'dispatch-platform-update.timer', 'dispatch-cloudflared.service', 'dispatch-dashboard-tunnel.service',
  'dispatch-release-watch.service', 'dispatch-release-watch.timer', 'dispatch-release-watch.path',
  'dispatch-release-delivery.service', 'dispatch-release-delivery.timer', 'dispatch-offsite-backup.service', 'dispatch-offsite-backup.timer', 'dispatch-offsite-backup.path', 'dispatch-recovery-prewarm.service', 'dispatch-recovery-prewarm.timer'];
const PACKAGES = ['ca-certificates', 'python3', 'restic', 'patchelf', 'dbus-user-session', 'apparmor-utils', 'libnss3',
  'libatk-bridge2.0-0t64', 'libx11-xcb1', 'libxcomposite1', 'libxdamage1', 'libxrandr2', 'libgbm1',
  'libasound2t64', 'libcups2t64', 'libgtk-3-0t64', 'fonts-liberation'];
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, ...options });
  if (result.status !== 0 || result.error) fail();
  return result.stdout.trim();
}
function account(value) {
  const parts = command('/usr/bin/getent', ['passwd', String(value)]).split(':');
  if (parts.length !== 7 || !/^[a-z_][a-z0-9_-]{0,63}$/.test(parts[0]) || !/^[1-9][0-9]*$/.test(parts[2])
      || !/^[1-9][0-9]*$/.test(parts[3]) || !path.isAbsolute(parts[5])) fail();
  return { name: parts[0], uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5] };
}
function systemctl(selected, args) {
  if (selected.scope === 'system') return command('/usr/bin/systemctl', args);
  return command('/usr/sbin/runuser', ['--user', selected.account.name, '--', '/usr/bin/env',
    `XDG_RUNTIME_DIR=/run/user/${selected.account.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${selected.account.uid}/bus`,
    '/usr/bin/systemctl', '--user', ...args]);
}
function supportedHost({ source = false } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.geteuid() !== 0) fail();
  const os = fs.readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(os) || !(source ? /^VERSION_ID="(?:24|26)\.04"$/m : /^VERSION_ID="24\.04"$/m).test(os)) fail();
}
function captureHostRecovery({ config, destination, kind = 'core', organizationId = null, snapshotSource = null, shareReleases = false }) {
  supportedHost({ source: true });
  const scopedCore = kind === 'core' && snapshotSource && JSON.parse(fs.readFileSync(path.join(snapshotSource, 'manifest.json'))).scope === 'core';
  const coreAccount = account(config.coreUid), userRoot = path.join(coreAccount.home, '.config/systemd/user');
  const database = path.join(config.localRoot, 'data/access-control/access-control.sqlite3');
  const db = new DatabaseSync(database, { readOnly: true });
  let installations;
  try {
    if (kind === 'core' && !scopedCore && db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE status='running'").get()) fail();
    installations = scopedCore ? [] : db.prepare(`SELECT i.organization_id,i.runtime_key,i.release_id,i.backend,i.status,o.status AS organization_status
      FROM installations i JOIN organizations o ON o.id=i.organization_id WHERE i.status NOT IN ('decommissioned','decommissioning')
      ${kind === 'dsp' ? 'AND i.organization_id=?' : ''}`).all(...(kind === 'dsp' ? [organizationId] : []));
    if(kind==='dsp'&&snapshotSource) {
      const job=db.prepare('SELECT j.* FROM installation_backups b JOIN installation_lifecycle_jobs j ON j.id=b.lifecycle_job_id WHERE b.id=? AND b.organization_id=?').get(path.basename(snapshotSource),organizationId);
      if(job&&installations.length===1){const receipts=JSON.parse(job.stage_receipts_json);installations[0].status=job.starting_state;installations[0].sync_was_running=receipts.inspect_schedule?.syncWasRunning===true;}
    }
  } finally { db.close(); }
  if (kind === 'dsp' && installations.length !== 1 || installations.some(i => i.backend !== 'native_service_v1')) fail();
  const accounts = [coreAccount], roots = [], services = [], releases = new Set(), hostAllocations=[];
  if(kind==='dsp') {
    const host=require('./release-delivery-files').privateJson('/etc/dispatch/oci-host.json',0);
    const registry=new DatabaseSync(path.join(host.stateRoot,'oci-host.sqlite3'),{readOnly:true});
    try {for(const item of installations){const allocation=registry.prepare('SELECT * FROM allocations WHERE runtime_key=?').get(item.runtime_key);if(!allocation)fail();hostAllocations.push(allocation);}}finally{registry.close();}
  }
  // The fenced host issuer runs as a separate unprivileged account. Restoring
  // its sudo rule and numeric configuration without that account leaves new
  // DSP provisioning broken even when existing DSP health checks pass.
  if (kind === 'core' && fs.existsSync('/etc/dispatch/oci-host.json')) {
    const host = require('./release-delivery-files').privateJson('/etc/dispatch/oci-host.json', 0);
    for (const uid of [host.authorityUid, host.helperCallerUid]) {
      if (!Number.isSafeInteger(uid) || uid < 1) fail();
      const selected = account(uid);
      if (uid === host.helperCallerUid && selected.gid !== host.helperCallerGid) fail();
      if (!accounts.some(existing => existing.uid === uid)) accounts.push(selected);
    }
  }
  function add(source, extra = {}) {
    if (fs.existsSync(source)) roots.push({ source, target: source, ...extra });
  }
  function unit(name, scope) {
    const source = path.join(scope === 'system' ? '/etc/systemd/system' : userRoot, name);
    if (!fs.existsSync(source)) return;
    const real = fs.realpathSync(source);
    if (!fs.statSync(real).isFile() || real !== source && !real.startsWith(path.join(config.localRoot, 'config/systemd') + '/')) fail();
    const text = fs.readFileSync(source, 'utf8');
    for (const match of text.matchAll(/\/opt\/(dispatch-(?:platform|runtime|control|updater|release-delivery))\/releases\/([a-z0-9][a-z0-9_.-]{2,95})\//g)) {
      releases.add(`/opt/${match[1]}/releases/${match[2]}`);
    }
    const service = { name, scope, account: coreAccount, file: source };
    const state = systemctl(service, ['show', name, '--property=ActiveState', '--value']);
    service.active = ['active', 'activating'].includes(state);
    service.enabled = systemctl(service, ['show', name, '--property=UnitFileState', '--value']) === 'enabled';
    services.push(service); add(source);
  }
  if (kind === 'core') {
    for (const name of SHARED_UNITS) { unit(name, 'user'); unit(name, 'system'); }
    if (scopedCore) {
      // Enumerate platform-owned roots positively: newly added DSP stores do
      // not become Core backup payload merely by sharing the local directory.
      const data=path.join(config.localRoot,'data');
      add(data,{exclude:fs.readdirSync(data).filter(name=>name!=='access-control'),overrides:{'access-control/access-control.sqlite3':path.join(snapshotSource,'access-control-before.sqlite3')}});
      roots.push(...require('./core-backup-files').recoveryFileRoots(config.localRoot, snapshotSource));
      add(path.join(config.localRoot,'config/systemd'));
    } else for (const child of ['data','state','config','secrets']) add(path.join(config.localRoot,child),
      child==='config'?{exclude:['core-maintenance.json']}:child==='data'&&snapshotSource?{overrides:{'access-control/access-control.sqlite3':path.join(snapshotSource,'access-control-before.sqlite3')}}:{});
    add('/etc/dispatch'); if (!scopedCore) add('/var/lib/dispatch-host'); add('/opt/dispatch-control/current');
    // Preserve discovery/verification metadata for earlier offsite archives.
    // Their encrypted payloads remain remote; transfer scratch space is excluded.
    if (!scopedCore) { add('/var/lib/dispatch-backup/archives'); add('/var/lib/dispatch-backup-receipts'); }
    if (fs.existsSync('/opt/dispatch-control/current')) releases.add(fs.realpathSync('/opt/dispatch-control/current'));
    for (const binary of ['cloudflared']) {
      const source = [`/usr/bin/${binary}`, `/usr/local/bin/${binary}`, path.join(coreAccount.home, '.local/bin', binary)].find(file => fs.existsSync(file));
      if (source) add(fs.realpathSync(source), { target: `/usr/local/lib/dispatch-recovery/${binary}` });
    }
    add('/etc/apparmor.d/dispatch-native-chrome');
  }
  for (const item of installations) {
    if (item.status === 'pending' && spawnSync('/usr/bin/getent', ['passwd', hostAccountName(item.runtime_key)]).status === 2) continue;
    const runtimeAccount = account(hostAccountName(item.runtime_key)); accounts.push(runtimeAccount);
    if (runtimeAccount.uid < 20000 || runtimeAccount.uid > 59999) fail();
    const suffix = opaqueRuntimeSuffix(item.runtime_key), root = path.join(HOST_TENANT_ROOT, suffix);
    if (kind === 'dsp') add(path.join(config.localRoot, 'secrets/oci-runtime-agents', `${item.runtime_key}.token`));
    add(root, { excludeContents: [`runtime/${item.runtime_key}/run`, `runtime/${item.runtime_key}/backups`,
      `runtime/${item.runtime_key}/staging`], exclude: ['engine-data', 'engine-config'],
      ...(kind === 'dsp' && snapshotSource ? { overrides: Object.fromEntries([
        ['data', 'data'], ['state', 'state'], ['config', 'config'], ['secrets/auth-broker', 'auth-secrets'],
      ].filter(([, child]) => fs.existsSync(path.join(snapshotSource, 'payload', child)))
        .map(([target, child]) => [`runtime/${item.runtime_key}/${target}`, path.join(snapshotSource, 'payload', child)])) } : {}) });
    releases.add(`/opt/dispatch-runtime/releases/${item.release_id}`);
    unit(`dispatch-runtime-agent-bridge-${suffix}.service`, 'system'); unit(`dispatch-dsp-${suffix}.service`, 'system');
  }
  for (const root of [...releases]) {
    const match = /^\/opt\/dispatch-platform\/releases\/([a-z0-9][a-z0-9_.-]{2,95})$/.exec(root);
    if (match) for (const base of ['dispatch-runtime', 'dispatch-control']) {
      const peer = `/opt/${base}/releases/${match[1]}`;
      if (fs.existsSync(peer)) releases.add(peer);
    }
  }
  // Finish shared immutable recovery payloads before freezing any legacy writers.
  const artifacts = shareReleases ? [...releases].map(root => require('./recovery-artifacts').prepareRelease(config, root)) : [];
  if (!shareReleases) for (const root of releases) add(root);
  if (kind === 'core') for (const name of fs.readdirSync('/etc/sudoers.d')) {
    if (!/^dispatch[-_a-z0-9.]*$/.test(name)) continue;
    const source = path.join('/etc/sudoers.d', name), text = fs.readFileSync(source, 'utf8');
    const mentioned = [...text.matchAll(/\/opt\/(dispatch-[a-z]+)\/releases\/([a-z][a-z0-9_.-]{2,95})\//g)]
      .map(m => `/opt/${m[1]}/releases/${m[2]}`);
    if (mentioned.every(root => releases.has(root))) add(source);
  }
  let organizationIds = installations.map(i => i.organization_id);
  const stopped = [];
  let nodeStage;
  try {
    // Scoped exports read sealed lifecycle/Core snapshots. Stopping their owners
    // here strands fenced jobs until lease expiry (and dashboard Requires=
    // dependencies also stop reconciliation). Legacy whole-host capture alone
    // still freezes writers, after the active-job checks above.
    const writers = captureWriters({ services, snapshotSource, scopedCore, kind });
    for (const service of writers.sort((a, b) => Number(b.name.endsWith('.timer')) - Number(a.name.endsWith('.timer')))) {
      stopped.push(service); systemctl(service, ['stop', service.name]);
    }
    if (kind === 'core' && !scopedCore) {
      const frozen = new DatabaseSync(database, { readOnly: true });
      try {
        if (frozen.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE status IN ('queued','running')").get()
            || frozen.prepare("SELECT 1 FROM installation_provisioning_requests WHERE status IN ('pending','dispatched')").get()) fail();
        const current = frozen.prepare(`SELECT i.organization_id,i.runtime_key,i.release_id,i.backend,i.status,o.status AS organization_status
          FROM installations i JOIN organizations o ON o.id=i.organization_id WHERE i.status NOT IN ('decommissioned','decommissioning')`).all();
        if (JSON.stringify(current) !== JSON.stringify(installations)) fail();
        organizationIds = frozen.prepare('SELECT id FROM organizations').all().map(row => row.id);
        if (snapshotSource) {
          const saved = new DatabaseSync(path.join(snapshotSource, 'access-control-before.sqlite3'), { readOnly: true });
          try { organizationIds.push(...saved.prepare('SELECT id FROM organizations').all().map(row => row.id)); }
          finally { saved.close(); }
        }
        organizationIds = [...new Set(organizationIds)].sort();
      } finally { frozen.close(); }
    }
    if (kind === 'core') {
      nodeStage = fs.mkdtempSync('/var/tmp/dispatch-node-capture-');
      const portable = path.join(nodeStage, 'runtime');
      require('./portable-node').bundleNode('/usr/bin/node', portable);
      add(portable, { target: '/usr/local/lib/dispatch-node' });
    }
    const metadata = { kind, ...(scopedCore ? {scope:'core'} : {}), organizationId, platform: 'ubuntu-24.04-amd64', localRoot: config.localRoot,
      accounts, hostAllocations, services: servicesForRecovery(kind,services,installations), installations, packages: PACKAGES,
      legacyEngine: [...releases].some(root => fs.existsSync(path.join(root, 'runtime-image.tar'))), createdAt: Date.now() };
    const captured = capsule.capture(destination, roots, metadata, new Set([0, ...accounts.map(a => a.uid)]));
    const proof = require('./recovery-artifacts').append(destination, captured, artifacts);
    return { ...proof, organizationIds, ...(kind === 'core' ? { organizationInventoryVersion: 1 } : {}) };
  } finally {
    if (nodeStage) fs.rmSync(nodeStage, { recursive: true, force: true });
    let failure;
    for (const service of stopped.reverse()) {
      try { systemctl(service, ['start', service.name]); } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  }
}
function captureWriters({ services, snapshotSource, scopedCore, kind }) {
  if (snapshotSource && (scopedCore || kind === 'dsp')) return [];
  return services.filter(s => s.active && (s.name.endsWith('.timer') || s.name === 'dispatch-dashboard.service'
    || s.name === 'dispatch-installation-reconcile.service' || /^dispatch-dsp-/.test(s.name))
    && !['dispatch-offsite-backup.timer', 'dispatch-platform-update.timer'].includes(s.name));
}
function servicesForRecovery(kind,services,installations) {
  // A DSP archive can be exported while its fenced backup job has the service
  // stopped. Record the state to resume, without changing the capture cleanup.
  if(kind!=='dsp')return services;
  return services.map(service=>{
    const item=installations.find(i=>[`dispatch-dsp-${opaqueRuntimeSuffix(i.runtime_key)}.service`,`dispatch-runtime-agent-bridge-${opaqueRuntimeSuffix(i.runtime_key)}.service`].includes(service.name));
    if(!item)return service;
    const running=item.status==='ready'&&item.organization_status==='active';
    return {...service,active:running,enabled:running};
  });
}
function recoveryRoots(metadata, roots) {
  if (!metadata || metadata.platform !== 'ubuntu-24.04-amd64' || !['core', 'dsp'].includes(metadata.kind)
      || !Array.isArray(metadata.accounts) || !metadata.accounts.length || !Array.isArray(metadata.services)
      || !Array.isArray(metadata.installations) || !Array.isArray(roots)) fail();
  const core = metadata.accounts[0];
  for (const a of metadata.accounts) {
    if (!/^[a-z_][a-z0-9_-]{0,63}$/.test(a.name) || !Number.isSafeInteger(a.uid) || a.uid < 1
        || !Number.isSafeInteger(a.gid) || a.gid < 1 || !path.isAbsolute(a.home)
        || path.resolve(a.home) !== a.home || /[\0\r\n]/.test(a.home)) fail();
  }
  if (!core.home.startsWith('/home/') || core.home.split('/').length !== 3
      || !metadata.localRoot.startsWith(core.home + '/') || path.resolve(metadata.localRoot) !== metadata.localRoot) fail();
  const allowed = new Set(metadata.kind === 'core' ? ['/etc/dispatch', '/var/lib/dispatch-host', '/opt/dispatch-control/current',
    '/var/lib/dispatch-backup/archives', '/var/lib/dispatch-backup-receipts',
    '/etc/apparmor.d/dispatch-native-chrome', '/usr/local/lib/dispatch-node', '/usr/local/lib/dispatch-recovery/cloudflared',
    ...['data', 'state', 'config', 'config/systemd', 'secrets','secrets/email', 'secrets/turnstile','secrets/cloudflared'].map(child => path.join(metadata.localRoot, child))] : []);
  if (metadata.kind === 'core')
    for (const root of roots)
      if (require('./core-backup-files').isCoreFile(path.relative(metadata.localRoot, root))) allowed.add(root);
  for (const item of metadata.installations) {
    if (!/^[a-z][a-z0-9_-]{2,95}$/.test(item.organization_id) || item.backend !== 'native_service_v1') fail();
    const suffix = opaqueRuntimeSuffix(item.runtime_key), selected = metadata.accounts.find(a => a.name === hostAccountName(item.runtime_key));
    if (!selected && item.status === 'pending') continue;
    if (!selected || selected.uid < 20000 || selected.uid > 59999 || selected.gid !== selected.uid
        || selected.home !== `${HOST_TENANT_ROOT}/${suffix}/home`) fail();
    allowed.add(`${HOST_TENANT_ROOT}/${suffix}`);
    allowed.add(path.join(metadata.localRoot, 'secrets/oci-runtime-agents', `${item.runtime_key}.token`));
  }
  for (const service of metadata.services) {
    if (!['user', 'system'].includes(service.scope) || typeof service.active !== 'boolean' || typeof service.enabled !== 'boolean'
        || service.scope === 'user' && metadata.kind !== 'core'
        || !SHARED_UNITS.includes(service.name) && !metadata.installations.some(item =>
          [`dispatch-dsp-${opaqueRuntimeSuffix(item.runtime_key)}.service`,
            `dispatch-runtime-agent-bridge-${opaqueRuntimeSuffix(item.runtime_key)}.service`].includes(service.name))) fail();
    const expected = path.join(service.scope === 'system' ? '/etc/systemd/system' : path.join(core.home, '.config/systemd/user'), service.name);
    if (service.file !== expected || JSON.stringify(service.account) !== JSON.stringify(core)) fail();
    allowed.add(expected);
  }
  for (const root of roots) {
    if (/^\/opt\/dispatch-(platform|runtime|control|updater|release-delivery)\/releases\/[a-z0-9][a-z0-9_.-]{2,95}$/.test(root)
        || metadata.kind === 'core' && /^\/etc\/sudoers\.d\/dispatch[-_a-z0-9.]*$/.test(root)) allowed.add(root);
    if (!allowed.has(root)) fail();
  }
  return allowed;
}
async function restoreHostRecovery({ directory, digest, installPackages = true }) {
  supportedHost();
  const bytes = fs.readFileSync(path.join(directory, 'recovery.json'));
  if (bytes.length > 128 * 1024 ** 2 || require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== digest) fail();
  const raw = JSON.parse(bytes), allowed = recoveryRoots(raw.metadata, raw.roots);
  const manifest = capsule.verify(directory, digest, allowed), metadata = manifest.metadata;
  if (metadata.kind !== 'core') fail(); // Individual DSP restores use the fenced lifecycle API.
  // The downloaded capsule is already on disk. Reserve space for staging,
  // cross-filesystem promotion and installed prerequisites before changing accounts.
  const payloadBytes = manifest.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0);
  const space = fs.statfsSync('/var/tmp');
  if (!Number.isSafeInteger(payloadBytes) || space.bavail * space.bsize < payloadBytes * 2 + 1024 ** 3) throw Error('recovery_space_unavailable');
  for (const root of manifest.roots) {
    try { fs.lstatSync(root); fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const selected of metadata.accounts) {
    const existing = spawnSync('/usr/bin/getent', ['passwd', selected.name], { encoding: 'utf8' });
    if (existing.status === 0) {
      if (JSON.stringify(account(selected.name)) !== JSON.stringify(selected)) fail();
      continue;
    }
    if (spawnSync('/usr/bin/getent', ['passwd', String(selected.uid)]).status === 0
        || spawnSync('/usr/bin/getent', ['group', String(selected.gid)]).status === 0) fail();
  }
  if (installPackages) {
    command('/usr/bin/apt-get', ['update'], { timeout: 600000 });
    command('/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', ...PACKAGES,
      ...(metadata.legacyEngine === true ? ['podman', 'uidmap', 'passt'] : [])],
      { timeout: 1200000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive' } });
  }
  for (const selected of metadata.accounts) {
    if (spawnSync('/usr/bin/getent', ['passwd', selected.name]).status === 0) continue;
    command('/usr/sbin/groupadd', ['--gid', String(selected.gid), selected.name]);
    // Service accounts must not acquire unrelated subordinate-ID ranges.
    command('/usr/sbin/useradd', ['--system', '--uid', String(selected.uid), '--gid', String(selected.gid), '--no-create-home',
      '--home-dir', selected.home, '--shell', '/usr/sbin/nologin', selected.name]);
  }
  const core = metadata.accounts[0];
  fs.mkdirSync(core.home, { recursive: true, mode: 0o700 });
  fs.chownSync(core.home, core.uid, core.gid);
  capsule.installFresh(directory, digest, allowed);
  for (const [directory, mode] of [[HOST_TENANT_ROOT, 0o755], ['/run/dispatch-runtime-agents', 0o711]]) {
    fs.mkdirSync(directory, {recursive:true, mode});
    fs.chownSync(directory, 0, 0); fs.chmodSync(directory, mode);
  }
  for (const directory of [metadata.localRoot, path.join(core.home, '.config'), path.join(core.home, '.config/systemd'), path.join(core.home, '.config/systemd/user')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chownSync(directory, core.uid, core.gid); fs.chmodSync(directory, 0o700);
  }
  for (const child of ['run', 'tmp', 'logs', 'staging', 'backups', 'installations']) {
    const directory = path.join(metadata.localRoot, child);
    fs.mkdirSync(directory, { mode: 0o700 }); fs.chownSync(directory, core.uid, core.gid);
  }
  // File-scoped capsules create ancestors without application ownership.
  // Recreate Core's writable private directories before starting its workers.
  for (const child of ['config', 'config/cloudflared', 'secrets', 'secrets/email', 'secrets/turnstile', 'secrets/cloudflared', 'secrets/oci-runtime-agents', 'data', 'data/access-control', 'state']) {
    const directory = path.join(metadata.localRoot, child);
    fs.mkdirSync(directory, {recursive:true, mode:0o700});
    fs.chownSync(directory, core.uid, core.gid); fs.chmodSync(directory, 0o700);
  }
  for (const name of ['cloudflared']) {
    const source = `/usr/local/lib/dispatch-recovery/${name}`;
    if (!fs.existsSync(source)) continue;
    const temp = `/usr/bin/.dispatch-restore-${name}`;
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL); fs.chmodSync(temp, 0o755); fs.renameSync(temp, `/usr/bin/${name}`);
    fs.unlinkSync(source);
  }
  if (fs.existsSync('/usr/local/lib/dispatch-recovery')) fs.rmdirSync('/usr/local/lib/dispatch-recovery');
  if (!fs.existsSync('/usr/local/lib/dispatch-node/node')) fail();
  const builtinRoot = '/usr/local/lib/dispatch-node/host-files/usr/share/nodejs';
  if (fs.existsSync(builtinRoot)) fs.cpSync(builtinRoot, '/usr/share/nodejs', { recursive: true, force: true });
  fs.symlinkSync('/usr/local/lib/dispatch-node/node', '/usr/bin/.dispatch-restore-node');
  fs.renameSync('/usr/bin/.dispatch-restore-node', '/usr/bin/node');
  for (const service of metadata.services) {
    const file = fs.realpathSync(service.file);
    const text = fs.readFileSync(file, 'utf8');
    const updated = text.replace(/^ExecStart=(?:\/usr\/local\/bin|\/home\/[a-z_][a-z0-9_-]*\/\.local\/bin)\/(node|cloudflared)(?=\s)/gm, 'ExecStart=/usr/bin/$1');
    if (updated !== text) fs.writeFileSync(file, updated);
  }
  for (const item of metadata.installations) {
    const selected = metadata.accounts.find(a => a.name === hostAccountName(item.runtime_key));
    if (!selected) continue;
    const runtime = path.join(HOST_TENANT_ROOT, opaqueRuntimeSuffix(item.runtime_key), 'runtime', item.runtime_key);
    for (const child of Object.values(require('../../../shared/paths/runtime-paths').MANAGED_INSTALLATION_DIRECTORY_FIELDS)) {
      const directory = path.join(runtime, child);
      let parent = directory;
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      if (fs.realpathSync(parent) !== parent) fail();
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) fail();
      fs.chownSync(directory, selected.uid, selected.gid); fs.chmodSync(directory, 0o700);
    }
    const bridge = `/run/dispatch-runtime-agents/${opaqueRuntimeSuffix(item.runtime_key)}`;
    fs.mkdirSync(bridge, { recursive: true, mode: 0o711 }); fs.chmodSync(bridge, 0o711);
  }
  // Restoring returns to the recorded application version. An interrupted
  // rollout is paused instead of replaying an update against restored data.
  const db = new DatabaseSync(path.join(metadata.localRoot, 'data/access-control/access-control.sqlite3'));
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    db.prepare("UPDATE platform_rollouts SET status='paused' WHERE status!='completed'").run();
    db.prepare("UPDATE platform_rollout_core SET status='failed',failure_code='restored_from_backup' WHERE status!='succeeded'").run();
    db.prepare("UPDATE platform_backup_requests SET status='failed',phase='failed',failure_code='restored_from_backup' WHERE status IN ('queued','running')").run();
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  if(metadata.scope==='core'||metadata.scope==='system') {
    const host=require('./release-delivery-files').privateJson('/etc/dispatch/oci-host.json',0);
    for(const directory of [host.stateRoot,host.authorityRoot]) {
      if(!directory.startsWith('/var/lib/dispatch-host/')||path.resolve(directory)!==directory)fail();
      fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
    }
    const registryModule='/opt/dispatch-control/current/host-helper-artifact/core/installations/src/oci-host-account-registry';
    const registry=require(registryModule).createOciHostAccountRegistry({stateRoot:host.stateRoot,identityAvailable:()=>false});registry.close();
    const ledger=new DatabaseSync(path.join(host.stateRoot,'oci-host.sqlite3'));
    try {
      ledger.exec('BEGIN IMMEDIATE');
      for(const allocation of metadata.hostAllocations||[]) {
        const item=metadata.installations.find(i=>i.runtime_key===allocation.runtime_key),owner=metadata.accounts.find(a=>a.name===allocation.account_name);
        if(!item||!owner||allocation.account_name!==hostAccountName(item.runtime_key)||allocation.uid!==owner.uid||allocation.gid!==owner.gid||allocation.status!=='active')fail();
        ledger.prepare('INSERT INTO allocations VALUES(?,?,?,?,?,?,?,?,?,?)').run(allocation.runtime_key,allocation.account_name,allocation.uid,allocation.gid,allocation.subuid_start,allocation.subgid_start,allocation.subid_count,allocation.status,allocation.created_at,allocation.updated_at);
      }
      ledger.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{ledger.close();}
  }
  if (fs.existsSync('/etc/apparmor.d/dispatch-native-chrome')) command('/usr/sbin/apparmor_parser', ['-r', '/etc/apparmor.d/dispatch-native-chrome']);
  fs.mkdirSync('/var/lib/dispatch-backup', { recursive: true, mode: 0o700 });
  fs.chmodSync('/var/lib/dispatch-backup', 0o700);
  fs.chownSync('/var/lib/dispatch-backup', 0, 0);
  require('./release-delivery-files').atomic('/var/lib/dispatch-backup/rediscover.json', { schemaVersion: 1 });
  command('/usr/bin/systemctl', ['daemon-reload']);
  command('/usr/bin/loginctl', ['enable-linger', core.name]);
  command('/usr/bin/systemctl', ['start', `user@${core.uid}.service`]);
  systemctl({ scope: 'user', account: core }, ['daemon-reload']);
  const suspended = service => metadata.installations.some(item =>
    (item.organization_status === 'suspended' || item.status === 'suspended')
    && [`dispatch-dsp-${opaqueRuntimeSuffix(item.runtime_key)}.service`,
      `dispatch-runtime-agent-bridge-${opaqueRuntimeSuffix(item.runtime_key)}.service`].includes(service.name));
  for (const service of metadata.services) {
    if (suspended(service)) systemctl(service, ['disable', service.name]);
    else if (service.enabled) systemctl(service, ['enable', service.name]);
  }
  const active = metadata.services.filter(service => !suspended(service) && (service.active
    || service.enabled && service.name.endsWith('.timer') || service.name === 'dispatch-dashboard.service'));
  for (const service of active.sort((a, b) => Number(a.name.endsWith('.timer')) - Number(b.name.endsWith('.timer')))) {
    if (/^dispatch-dsp-/.test(service.name) && metadata.installations.some(item => item.organization_status === 'suspended'
      && service.name === `dispatch-dsp-${opaqueRuntimeSuffix(item.runtime_key)}.service`)) continue;
    systemctl(service, ['start', '--no-block', service.name]);
  }
  const dashboard = metadata.services.find(service => service.name === 'dispatch-dashboard.service');
  if (!dashboard) fail();
  const match = /\/opt\/dispatch-platform\/releases\/([a-z][a-z0-9_.-]{2,95})\/core-artifact\/code\//.exec(fs.readFileSync(dashboard.file, 'utf8'));
  if (!match) fail();
  const deployment = JSON.parse(fs.readFileSync(`/opt/dispatch-platform/releases/${match[1]}/core-artifact/deployment.json`));
  if (deployment.localRoot !== metadata.localRoot || deployment.releaseId !== match[1]) fail();
  const controlSetting = /^DISPATCH_RUNTIME_AGENT_CONTROL_SOCKET=(.+)$/m.exec(fs.readFileSync(path.join(metadata.localRoot, 'config/provisioning.env'), 'utf8'));
  const controlSocket = controlSetting?.[1].replace(/^['"]|['"]$/g, '') || path.join(metadata.localRoot, 'run/runtime-agent-control.sock');
  const controlModule = `/opt/dispatch-platform/releases/${match[1]}/core-artifact/code/core/agents/src/control`;
  const restoreSchedule = `const call=(op,args)=>require(process.argv[1]).runtimeAgentControlInvoke(process.argv[2],process.argv[3],op,args,{timeoutMs:5000});(async()=>{const id='paycom-main-workforce',want=process.argv[4]==='true'?'running':'stopped';let r=await call('sync.status',{id});if(!r.ok)throw Error();if(r.data.desiredState!==want){r=await call(want==='running'?'sync.start':'sync.stop',{id});if(!r.ok)throw Error();}r=await call('sync.status',{id});if(!r.ok||r.data.desiredState!==want)throw Error();})().catch(()=>process.exitCode=1);`;
  const probeRuntime = `require(process.argv[1]).runtimeAgentControlInvoke(process.argv[2],process.argv[3],'health',{}, {timeoutMs:5000}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1);`;
  let healthy = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = require('node:http').get({ hostname: '127.0.0.1', port: deployment.port, path: '/api/platform/core-health',
          headers: { Host: new URL(deployment.publicOrigin).host, 'CF-Visitor': '{"scheme":"https"}' }, timeout: 2000 }, response => {
          let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 4096) request.destroy(); });
          response.on('end', () => { try { if (response.statusCode !== 200) throw Error(); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
        });
        request.on('error', reject); request.on('timeout', () => request.destroy(Error('restore_health_timeout')));
      });
      if (body.ok && body.data.releaseId === deployment.releaseId && body.data.sourceCommit === deployment.sourceCommit
          && active.filter(service => /^dispatch-(dsp|runtime-agent-bridge)-/.test(service.name))
            .every(service => systemctl(service, ['is-active', service.name]) === 'active')) {
        for (const item of metadata.installations) {
          if (!active.some(service => service.name === `dispatch-dsp-${opaqueRuntimeSuffix(item.runtime_key)}.service`)) continue;
          command('/usr/sbin/runuser', ['--user', core.name, '--', '/usr/bin/node', '--no-warnings', '-e', probeRuntime,
            controlModule, controlSocket, item.runtime_key], { timeout: 10000 });
          if(typeof item.sync_was_running==='boolean')command('/usr/sbin/runuser',['--user',core.name,'--','/usr/bin/node','--no-warnings','-e',restoreSchedule,controlModule,controlSocket,item.runtime_key,String(item.sync_was_running)],{timeout:20000});
        }
        healthy = true; break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!healthy) throw Error('restore_service_health_failed');
  return { status: 'restored', dsps: metadata.installations.length, coreVerified: true };
}
module.exports = { captureWriters, servicesForRecovery, captureHostRecovery, restoreHostRecovery, recoveryRoots, supportedHost, account, command, systemctl, PACKAGES };
