'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  ChromeBrowserRuntime, chromeArguments, ensurePersistentProfile, persistentProfileId,
  removePersistentProfile, clearRuntimeArtifacts, profileProcessPids,
} = require('../src/browser-runtime');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-browser-runtime-'));
  fs.chmodSync(root, 0o700);
  return { root, stateRoot: path.join(root, 'sessions') };
}

test('Paycom browser profiles are stable, non-incognito, and survive reconciliation', async () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
    assert.equal(layout.id, persistentProfileId('paycom', 'paycom-main'));
    fs.writeFileSync(path.join(layout.profileDirectory, 'retained-state'), 'fixture', { mode: 0o600 });
    const ephemeral = path.join(stateRoot, 'f'.repeat(32));
    fs.mkdirSync(ephemeral, { mode: 0o700 });

    const persistentArgs = chromeArguments({ persistent: true, profileDirectory: layout.profileDirectory, headless: true });
    const ephemeralArgs = chromeArguments({ persistent: false, profileDirectory: ephemeral, headless: true });
    assert.equal(persistentArgs.includes('--incognito'), false);
    assert.equal(persistentArgs.includes('--restore-last-session'), true);
    assert.equal(ephemeralArgs.includes('--incognito'), true);
    assert.equal(ephemeralArgs.includes('--restore-last-session'), false);
    assert.equal(persistentArgs.includes(`--user-data-dir=${layout.profileDirectory}`), true);

    const runtime = new ChromeBrowserRuntime({
      stateRoot,
      executable: '/usr/bin/true',
      launcher: '/usr/bin/true',
      persistentProviders: ['paycom'],
    });
    await runtime.reconcile();
    assert.equal(fs.readFileSync(path.join(layout.profileDirectory, 'retained-state'), 'utf8'), 'fixture');
    assert.equal(fs.existsSync(ephemeral), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inactive profile cleanup discards tab restore files but preserves cookies and external symlink targets', () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'fixture');
    const directory = path.join(layout.profileDirectory, 'Default');
    fs.mkdirSync(directory, { mode: 0o700 });
    const external = path.join(root, 'external');
    fs.mkdirSync(external, { mode: 0o700 });
    fs.writeFileSync(path.join(external, 'keep'), 'external');
    fs.symlinkSync(external, path.join(directory, 'Sessions'));
    fs.writeFileSync(path.join(directory, 'Last Session'), 'stale-login-tab');
    fs.writeFileSync(path.join(directory, 'Cookies'), 'retained-cookie-db');
    clearRuntimeArtifacts(layout.profileDirectory);
    assert.equal(fs.existsSync(path.join(directory, 'Sessions')), false);
    assert.equal(fs.existsSync(path.join(directory, 'Last Session')), false);
    assert.equal(fs.readFileSync(path.join(directory, 'Cookies'), 'utf8'), 'retained-cookie-db');
    assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'external');
    fs.rmSync(directory, { recursive: true });
    fs.symlinkSync(external, directory);
    assert.throws(() => clearRuntimeArtifacts(layout.profileDirectory), error => error.code === 'unsafe_browser');
    assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'external');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('persistent profile cleanup removes only the bound profile and does not follow Chrome symlinks', () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
    const sentinel = path.join(root, 'sentinel');
    fs.writeFileSync(sentinel, 'keep', { mode: 0o600 });
    fs.writeFileSync(path.join(layout.profileDirectory, 'DevToolsActivePort'), 'stale', { mode: 0o600 });
    fs.symlinkSync(sentinel, path.join(layout.profileDirectory, 'SingletonLock'));
    clearRuntimeArtifacts(layout.profileDirectory);
    assert.equal(fs.existsSync(path.join(layout.profileDirectory, 'DevToolsActivePort')), false);
    assert.throws(() => fs.lstatSync(path.join(layout.profileDirectory, 'SingletonLock')), error => error.code === 'ENOENT');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');

    assert.equal(removePersistentProfile(stateRoot, 'paycom', 'paycom-main'), true);
    assert.equal(fs.existsSync(layout.directory), false);
    assert.equal(removePersistentProfile(stateRoot, 'paycom', 'paycom-main'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconciliation removes stale PulseAudio links so the saved profile can be backed up', async () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
    const pulse = path.join(layout.profileDirectory, '.config', 'pulse');
    fs.mkdirSync(pulse, { recursive: true, mode: 0o700 });
    const sentinel = path.join(root, 'audio-runtime');
    fs.mkdirSync(sentinel, { mode: 0o700 });
    fs.writeFileSync(path.join(sentinel, 'keep'), 'external runtime', { mode: 0o600 });
    const links = ['a'.repeat(32) + '-runtime', 'b'.repeat(32) + '-runtime'];
    fs.symlinkSync(sentinel, path.join(pulse, links[0]));
    fs.symlinkSync(path.join(root, 'missing-runtime'), path.join(pulse, links[1]));
    fs.writeFileSync(path.join(layout.profileDirectory, 'retained-state'), 'saved login', { mode: 0o600 });
    fs.writeFileSync(path.join(pulse, 'cookie'), 'saved audio cookie', { mode: 0o600 });
    const dataRoot = path.join(root, 'data'), backupsRoot = path.join(root, 'backups');
    for (const directory of [dataRoot, backupsRoot]) fs.mkdirSync(directory, { mode: 0o700 });
    const { createInstallationBackupManager } = require('dispatch-core/core/installations/src/backups.js');
    const manager = createInstallationBackupManager({ layout: {
      installationRoot: root, directories: { dataRoot, stateRoot, backupsRoot },
    } });
    const spec = { id: 'backup_pulse_cleanup', purpose: 'manual', manifestRevision: 1,
      releaseId: 'dispatch_fixture', status: 'reserved' };
    assert.throws(() => manager.snapshot(spec, fn => fn()), error => error.code === 'backup_failed');
    await new ChromeBrowserRuntime({ stateRoot, executable: '/usr/bin/true', launcher: '/usr/bin/true',
      persistentProviders: ['paycom'] }).reconcile();
    for (const name of links) assert.throws(() => fs.lstatSync(path.join(pulse, name)), error => error.code === 'ENOENT');
    assert.equal(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8'), 'external runtime');
    assert.equal(fs.readFileSync(path.join(pulse, 'cookie'), 'utf8'), 'saved audio cookie');
    assert.equal(manager.snapshot(spec, fn => fn()).status, 'snapshot');
    assert.equal(fs.readFileSync(path.join(backupsRoot, spec.id, 'payload/state', layout.id, 'chrome/retained-state'), 'utf8'), 'saved login');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PulseAudio cleanup preserves ordinary files and unrelated links', () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
    const pulse = path.join(layout.profileDirectory, '.config', 'pulse');
    fs.mkdirSync(pulse, { recursive: true, mode: 0o700 });
    const file = path.join(pulse, 'a'.repeat(32) + '-runtime');
    fs.writeFileSync(file, 'keep', { mode: 0o600 });
    const link = path.join(pulse, 'unrelated-runtime');
    fs.symlinkSync(file, link);
    clearRuntimeArtifacts(layout.profileDirectory);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('inactive browser cleanup repairs only known cache directories and permits a verified snapshot', () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
    const cache = path.join(layout.profileDirectory, '.cache'), fonts = path.join(cache, 'fontconfig');
    fs.mkdirSync(fonts, { recursive: true });
    for (const file of [cache, fonts]) fs.chmodSync(file, 0o755);
    fs.writeFileSync(path.join(fonts, 'retained-font'), 'keep', { mode: 0o600 });
    const dataRoot = path.join(root, 'data'), backupsRoot = path.join(root, 'backups');
    for (const file of [dataRoot, backupsRoot]) fs.mkdirSync(file, { mode: 0o700 });
    const manager = require('dispatch-core/core/installations/src/backups.js').createInstallationBackupManager({
      layout: { installationRoot: root, directories: { stateRoot, dataRoot, backupsRoot } },
    });
    const spec = { id: 'backup_cache_cleanup', purpose: 'manual', manifestRevision: 1, releaseId: 'dispatch_fixture', status: 'reserved' };
    assert.throws(() => manager.snapshot(spec, fn => fn()), /backup_failed/);
    clearRuntimeArtifacts(layout.profileDirectory);
    for (const file of [cache, fonts]) assert.equal(fs.statSync(file).mode & 0o777, 0o700);
    assert.equal(manager.snapshot(spec, fn => fn()).status, 'snapshot');
    assert.equal(fs.readFileSync(path.join(fonts, 'retained-font'), 'utf8'), 'keep');
    clearRuntimeArtifacts(layout.profileDirectory); // idempotent on subsequent reconciliation
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cache cleanup rejects linked parents and unexpected writable directories', () => {
  for (const linked of [true, false]) {
    const { root, stateRoot } = fixture();
    try {
      const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
      const cache = path.join(layout.profileDirectory, '.cache'), external = path.join(root, 'external');
      fs.mkdirSync(external, { mode: 0o755 }); fs.chmodSync(external, 0o755);
      if (linked) fs.symlinkSync(external, cache);
      else { fs.mkdirSync(cache, { mode: 0o777 }); fs.chmodSync(cache, 0o777); }
      assert.throws(() => clearRuntimeArtifacts(layout.profileDirectory), /unsafe_browser/);
      assert.equal(fs.statSync(external).mode & 0o777, 0o755);
      if (!linked) assert.equal(fs.statSync(cache).mode & 0o777, 0o777);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('PulseAudio cleanup refuses symlinked parent directories', () => {
  for (const parent of ['.config', 'pulse']) {
    const { root, stateRoot } = fixture();
    try {
      const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
      const external = path.join(root, 'external');
      fs.mkdirSync(external, { mode: 0o700 });
      const link = path.join(external, 'a'.repeat(32) + '-runtime');
      fs.symlinkSync(path.join(root, 'missing'), link);
      const config = path.join(layout.profileDirectory, '.config');
      if (parent === 'pulse') fs.mkdirSync(config, { mode: 0o700 });
      fs.symlinkSync(external, parent === '.config' ? config : path.join(config, 'pulse'));
      assert.throws(() => clearRuntimeArtifacts(layout.profileDirectory), error => error.code === 'unsafe_browser');
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('reconciliation never kills a PID named only by a legacy marker', async () => {
  const { root, stateRoot } = fixture();
  try {
    const layout = ensurePersistentProfile(stateRoot, 'paycom', 'paycom-main');
    fs.writeFileSync(layout.marker, `${JSON.stringify({
      version: 1, brokerPid: process.pid, browserPid: process.pid,
    })}\n`, { mode: 0o600, flag: 'wx' });
    const runtime = new ChromeBrowserRuntime({
      stateRoot,
      executable: '/usr/bin/true',
      launcher: '/usr/bin/true',
      persistentProviders: ['paycom'],
    });
    await runtime.reconcile();
    assert.equal(fs.existsSync(layout.marker), false);
    assert.equal(fs.existsSync(layout.profileDirectory), true);
    assert.equal(process.kill(process.pid, 0), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persistent profile removal refuses an unmarked same-user process using the profile', async () => {
  const { root, stateRoot } = fixture();
  let child;
  try {
    const layout = ensurePersistentProfile(stateRoot, 'amazon-logistics', 'amazon-operations');
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', `--user-data-dir=${layout.profileDirectory}`], {
      stdio: 'ignore',
    });
    const deadline = Date.now() + 2_000;
    while (!profileProcessPids(layout.profileDirectory).includes(child.pid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(profileProcessPids(layout.profileDirectory).includes(child.pid), true);
    assert.throws(() => removePersistentProfile(stateRoot, 'amazon-logistics', 'amazon-operations'), error => error.code === 'browser_profile_busy');
    assert.throws(() => clearRuntimeArtifacts(layout.profileDirectory), error => error.code === 'browser_profile_busy');
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
