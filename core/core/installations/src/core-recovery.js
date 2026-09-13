'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomic, privateJson } = require('./release-delivery-files');
const failure = code => Object.assign(new Error(code), { code });
const TERMINAL = new Set(['promoted', 'recovered']);

// The journal is outside the database being restored. Persist intent before every
// destructive operation; after promotion or restored-service startup, never rewind data.
function createCoreRecovery({ localRoot, context, adapter }) {
  if (!/^rollout_[a-f0-9]{32}$/.test(context.rolloutId) || !Number.isSafeInteger(context.attempt) || context.attempt < 1) throw failure('core_context_invalid');
  const root = path.join(localRoot, 'backups/platform-core', context.rolloutId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(root) !== root) throw failure('core_recovery_storage_invalid');
  const file = path.join(root, 'recovery.json');
  let journal = privateJson(file, process.geteuid(), true);
  if (journal && (journal.schemaVersion !== 1 || journal.releaseId !== context.releaseId || journal.rolloutId !== context.rolloutId
      || !Number.isSafeInteger(journal.attempt) || journal.attempt < 1 || !/^[a-f0-9]{64}$/.test(journal.nonce)
      || !journal.prior || typeof journal.prior !== 'object'
      || (journal.snapshot && (!/^[a-f0-9]{64}$/.test(journal.snapshot.sha256) || !Number.isSafeInteger(journal.snapshot.size) || journal.snapshot.size < 1))
      || !['preparing', 'prepared', 'switching', 'verifying', 'promoted', 'recovering', 'restored', 'recovered'].includes(journal.phase))) throw failure('core_recovery_journal_invalid');
  const save = phase => { journal.phase = phase; atomic(file, journal); };
  const directory = () => path.join(root, `attempt-${journal.attempt}`);
  async function recover() {
    if (!journal) return;
    if (journal.phase === 'promoted') throw failure('core_already_promoted');
    if (journal.phase === 'recovered') return;
    // 'restored' is durable BEFORE the old service can accept even one new write.
    if (journal.phase !== 'restored') {
      save('recovering');
      await adapter.stopCandidate();
      if (journal.snapshot) await adapter.restore(directory(), journal.snapshot);
      await adapter.restoreServices(journal.prior);
      save('restored');
    }
    await adapter.startPrior(journal.prior);
    await adapter.verifyPrior(journal.prior);
    await adapter.releaseMaintenance(journal);
    await adapter.restoreScheduling(journal.prior);
    save('recovered');
  }
  async function guarded(fn) {
    try { return await fn(); }
    catch (error) {
      // Simulated power loss is injected by tests by killing a child, never by a
      // production flag. All ordinary failures attempt recovery immediately.
      if (journal && !TERMINAL.has(journal.phase)) {
        try { await recover(); }
        catch { throw failure('core_recovery_required'); }
      }
      throw error;
    }
  }
  async function apply() {
    return guarded(async () => {
      if (journal?.phase === 'promoted') { await adapter.verifyPromoted(); return; }
      if (journal && journal.phase !== 'recovered') {
        await recover(); throw failure('core_interrupted_update_recovered');
      }
      if (journal && context.attempt <= journal.attempt) throw failure('core_update_recovered');
      const prior = await adapter.preflight(); // Nothing is stopped before this passes.
      journal = { schemaVersion: 1, rolloutId: context.rolloutId, releaseId: context.releaseId,
        attempt: context.attempt, phase: 'preparing', prior, snapshot: null, nonce: crypto.randomBytes(32).toString('hex') };
      save('preparing');
      fs.mkdirSync(directory(), { mode: 0o700 });
      if (adapter.armRecovery) await adapter.armRecovery(journal);
      await adapter.enterMaintenance(journal);
      await adapter.drain();
      await adapter.stopCandidate();
      journal.snapshot = await adapter.snapshot(directory());
      save('prepared');
      if (adapter.verifyOffsite) await adapter.verifyOffsite(directory(), journal.snapshot);
      save('switching');
      await adapter.installCandidate();
      await adapter.startCandidate();
      save('verifying');
    });
  }
  async function verify() {
    return guarded(async () => {
      if (!journal) throw failure('core_recovery_journal_missing');
      if (journal.phase === 'promoted') {
        await adapter.verifyPromoted();
        if (adapter.updateSupervisor) await adapter.updateSupervisor();
        await adapter.releaseMaintenance(journal);
        await adapter.restoreScheduling(journal.prior);
        if (adapter.disarmRecovery) await adapter.disarmRecovery();
        return;
      }
      if (journal.phase !== 'verifying') {
        await recover(); throw failure('core_interrupted_update_recovered');
      }
      await adapter.verifyCandidate(journal);
      // Commit before opening traffic. A later retry may finish opening traffic,
      // but must not restore a pre-update database after clients have written.
      save('promoted');
      if (adapter.updateSupervisor) await adapter.updateSupervisor();
      await adapter.releaseMaintenance(journal);
      await adapter.restoreScheduling(journal.prior);
      if (adapter.disarmRecovery) await adapter.disarmRecovery();
    });
  }
  return { apply, verify, recover, view: () => journal };
}
module.exports = { createCoreRecovery };
