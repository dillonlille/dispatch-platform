'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { inventory, verifyRelease, secureCopy } = require('../../shared/releases/package');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, privileged, syncDirectory, acquireLock } = require('../controller/operations');
const { DirectoryJournal } = require('../controller/journal');
const { runtimeSource, fileFor } = require('./runtime');
const { unitFor } = require('../services/plugin-backend');
const receiptFile = paths => path.join(paths.local, 'state/updates/installed-core.json');
function verifyLive(paths, manifest) {
  const expected = manifest.files.filter(item => item.path.startsWith('code/')).map(item => ({ ...item, path: item.path.slice(5) }));
  if (JSON.stringify(inventory(paths.live)) !== JSON.stringify(expected)) throw new Error('release_core_baseline_changed');
}
function coreHooks({ paths, configuration, releases, systemctl = async args => privileged(['/usr/bin/systemctl', ...args], { timeout: 300000 }), fetchImpl = require('./health').requestHealth, healthTimeoutMs = 90000 }) {
  const root = privateDirectory(path.join(paths.local, 'backups/updates/core'));
  let controllerLock, operationLock;
  const unlock = () => {
    if (operationLock !== undefined) { fs.closeSync(operationLock); operationLock = undefined; }
    if (controllerLock !== undefined) { fs.closeSync(controllerLock); controllerLock = undefined; }
  };
  const lock = () => { controllerLock = acquireLock(paths, 'controller'); operationLock = acquireLock(paths); };
  const baseline = () => {
    for (const dsp of new DirectoryJournal(paths).all().filter(item => item.desiredState !== 'retired')) {
      const selected = releases().active.dsps[dsp.id];
      if (!selected || privateJson(fileFor(paths, dsp.id), process.geteuid(), true)?.digest !== selected || runtimeSource(paths, dsp.id) === paths.live) throw new Error('release_dsp_baseline_required');
    }
  };
  const units = ['dispatch-platform-local.service', 'dispatch-api.service', unitFor(paths)];
  const targetFor = token => {
    if (!token || !/^[a-f0-9]{32}$/.test(token.id)) throw new Error('release_snapshot_invalid');
    return path.join(root, token.id);
  };
  const stop = async () => {
    for (const unit of units) {
      try { await systemctl(['stop', unit]); }
      catch (error) {
        // A collected backend unit may already be gone after a failed API
        // startup. Other stop failures must still block the code/state swap.
        const status = await systemctl(['show', unit, '-p', 'LoadState']);
        if (status.trim() !== 'LoadState=not-found') throw error;
      }
    }
    for (const unit of units) {
      const status = await systemctl(['show', unit, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID']);
      const fields = Object.fromEntries(status.trim().split('\n').map(line => line.split('=')));
      if (!['inactive', 'failed'].includes(fields.ActiveState) || fields.MainPID !== '0' || fields.ControlPID !== '0') throw new Error('release_core_not_drained');
    }
  };
  const start = async () => {
    await systemctl(['start', 'dispatch-api.service']);
    await systemctl(['start', 'dispatch-platform-local.service']);
  };
  const health = async (digest, version, nonce) => {
    const deadline = Date.now() + healthTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const origin = require('../controller/dashboard-settings').loadDashboardSettings(paths)?.publicOrigin;
        const headers = { ...(nonce ? { 'X-Dispatch-Recovery-Probe': nonce } : {}), ...(origin ? { Host: new URL(origin).host, 'CF-Visitor': '{"scheme":"https"}' } : {}) };
        const response = await fetchImpl(`http://127.0.0.1:${configuration.apiPort}/api/platform/core-health`, { signal: AbortSignal.timeout(3000), headers, redirect: 'error' });
        const body = await response.json();
        if (response.ok && body.ok && body.data?.digest === digest && body.data.version === version && (!nonce || body.data.recoveryProbe === 'passed')) return true;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(500, deadline - Date.now()))));
    }
    return false;
  };
  return {
    async withActivation(_c, work) { try { return await work(); } finally { unlock(); } },
    async prepare(c) {
      if (c.product !== 'core' || !c.previousDigest) throw new Error('release_baseline_required');
      const prior = releases().releases.core[c.previousDigest];
      if (!prior) throw new Error('release_baseline_required');
      verifyLive(paths, verifyRelease(prior.directory, prior.digest));
      // A Core-only tree cannot supply a missing DSP runtime. This gate is
      // deliberately strict during the initial monolithic-to-split cutover.
      baseline();
      const token = { id: crypto.randomBytes(16).toString('hex'), nonce: crypto.randomBytes(32).toString('hex'), previousDigest: c.previousDigest };
      const target = privateDirectory(targetFor(token));
      if (fs.statSync(target).dev !== fs.statSync(paths.live).dev) throw new Error('release_filesystem_mismatch');
      secureCopy(path.join(c.directory, 'code'), path.join(target, 'next'));
      return token;
    },
    async drain() { await stop(); lock(); },
    async snapshot(c) {
      baseline();
      const prior = releases().releases.core[c.previousDigest];
      verifyLive(paths, verifyRelease(prior.directory, prior.digest));
      const target = targetFor(c.preparation);
      const roots = require('./core-state').capture(paths, target);
      // Check the database while the API is stopped. Sidecars are included in
      // the stopped state snapshot; no running connection is copied on rollback.
      const db = new DatabaseSync(path.join(paths.local, 'state/access-control/access-control.sqlite3'), { readOnly: true });
      try { if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('release_database_invalid'); }
      finally { db.close(); }
      atomic(path.join(target, 'snapshot.json'), { roots, digest: c.digest, previousDigest: c.previousDigest });
      return { id: c.preparation.id };
    },
    async start(c) {
      const target = targetFor(c.preparation);
      fs.renameSync(paths.live, path.join(target, 'previous')); syncDirectory(paths.platformRoot); syncDirectory(target);
      fs.renameSync(path.join(target, 'next'), paths.live); syncDirectory(paths.platformRoot); syncDirectory(target);
      verifyLive(paths, c.manifest);
      atomic(receiptFile(paths), { digest: c.digest, version: c.manifest.version });
      unlock(); await start();
    },
    verify: c => health(c.digest, c.manifest.version, c.preparation?.nonce),
    async restore(c) {
      if (!c.preparation) return;
      unlock(); await stop(); lock();
      const target = targetFor(c.preparation), saved = privateJson(path.join(target, 'snapshot.json'), process.geteuid(), true);
      const previous = path.join(target, 'previous');
      if (fs.existsSync(previous)) {
        if (!saved || saved.digest !== c.digest || saved.previousDigest !== c.previousDigest) throw new Error('release_snapshot_invalid');
        if (fs.existsSync(paths.live)) {
          const failed = path.join(target, 'failed');
          if (fs.existsSync(failed)) throw new Error('release_restore_conflict');
          fs.renameSync(paths.live, failed);
        }
        fs.renameSync(previous, paths.live); syncDirectory(paths.platformRoot); syncDirectory(target);
      }
      if (saved) {
        require('./core-state').restore(paths, target, saved.roots);
      } else if (c.snapshot) throw new Error('release_snapshot_missing');
      const prior = releases().releases.core[c.previousDigest];
      verifyLive(paths, verifyRelease(prior.directory, prior.digest));
      atomic(receiptFile(paths), { digest: prior.digest, version: prior.version });
      unlock(); await start();
      if (!await health(prior.digest, prior.version, c.preparation.nonce)) throw new Error('release_rollback_health_failed');
    },
  };
}
module.exports = { coreHooks, verifyLive, receiptFile };
