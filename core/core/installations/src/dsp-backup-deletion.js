'use strict';
// Runs only inside the root exporter's flock. Core sees an opaque completion
// receipt; storage credentials and restic object identifiers never enter its API.
const fs = require('node:fs');
const path = require('node:path');
const { atomic, privateJson } = require('./release-delivery-files');
const { receiptKey, publicRootJson } = require('./offsite-policy');
const { HOST_TENANT_ROOT, opaqueRuntimeSuffix } = require('../../runtime-host-identity');
const fail = () => { throw Object.assign(Error('offsite_backup_unavailable'), { code: 'offsite_backup_unavailable' }); };
const idPattern = /^(backup|breq)_[a-f0-9]{32}$/;

function mayContainOrganization(proof, organizationId) {
  // Older receipts only enumerated installed runtimes, omitting shared identity
  // records. Only the complete inventory can prove a Core archive unrelated.
  return !(proof?.organizationInventoryVersion === 1 && Array.isArray(proof.organizationIds)
    && proof.organizationIds.every(id => typeof id === 'string' && /^org_[a-z0-9_]+$/.test(id))
    && !proof.organizationIds.includes(organizationId));
}

async function purgeDspBackups({ config, jobs, backups, records, sets = [], storage, run, workRoot, receiptRoot,
  ownerUid = 0, clock = Date.now }) {
  const deletedRuntimeKeys = [], deletingOrganizations = new Set();
  let failed = 0;
  for (const job of jobs) {
    deletingOrganizations.add(job.organization_id);
    deletedRuntimeKeys.push(job.runtime_key);
    try {
      if (!/^life_[a-f0-9]{32}$/.test(job.id) || !/^[a-z][a-z0-9_-]{2,95}$/.test(job.runtime_key)
          || !['platform_removal', 'platform_lifecycle'].includes(job.authority_scope) || JSON.parse(JSON.parse(job.stage_receipts_json).__request).operation !== 'destroy') fail();
      const proofFile = path.join(receiptRoot, `deleted-${job.id}.json`);
      if (fs.existsSync(proofFile)) {
        const proof = publicRootJson(proofFile, false, ownerUid);
        if (proof.status !== 'destroyed' || proof.jobId !== job.id || proof.organizationId !== job.organization_id
            || proof.runtimeKey !== job.runtime_key) fail();
        continue;
      }
      const selected = records.filter(row => {
        if (row.organization_id === job.organization_id) return true;
        if (row.kind !== 'core') return false;
        if (!idPattern.test(row.id)) fail();
        const file = path.join(workRoot, 'archives', `${row.id}.json`);
        const proof = fs.existsSync(file) ? privateJson(file, ownerUid) : null;
        if (proof && (proof.id !== row.id || proof.kind !== 'core' || proof.organizationId !== null)) fail();
        if (!proof && JSON.parse(row.metadata_json || '{}').scope === 'core') {
          const source = path.join(config.localRoot, 'backups/scheduled-core', row.id);
          if (fs.existsSync(source)) {
            require('./offsite-backup').verifySnapshot(source, config.coreUid);
            const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
            // A newly created Core snapshot may not yet have an export receipt.
            // Its validated isolated payload still proves it contains no DSP.
            if (manifest.version === 3 && manifest.scope === 'core') return false;
          }
        }
        return mayContainOrganization(proof, job.organization_id);
      });
      if (selected.some(row => !['dsp', 'core'].includes(row.kind) || !idPattern.test(row.id))) fail();
      const ids = new Set([...selected.map(row => row.id), ...backups.filter(row => row.organization_id === job.organization_id).map(row => row.id)]);
      if ([...ids].some(id => !idPattern.test(id))) fail();
      const installation = path.join(HOST_TENANT_ROOT, opaqueRuntimeSuffix(job.runtime_key), 'runtime', job.runtime_key);
      const tags = new Set([...ids].map(id => receiptKey(path.join(installation, 'backups', id))));
      for (const row of selected.filter(row => row.kind === 'core')) tags.add(receiptKey(path.join(config.localRoot, 'backups/scheduled-core', row.id)));
      for (const name of fs.readdirSync(receiptRoot)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const proof = publicRootJson(path.join(receiptRoot, name), false, ownerUid, 1024 * 1024);
        if (Array.isArray(proof.organizationIds) && mayContainOrganization(proof, job.organization_id)) tags.add(name.slice(0, -5));
      }
      const snapshots = () => {
        const result = run(['snapshots']).flat();
        if (result.some(item => !/^[a-f0-9]{64}$/.test(item.id) || !Array.isArray(item.tags))) fail();
        return result;
      };
      const before = snapshots();
      const targets = before.filter(item => item.tags.some(tag => tags.has(tag)));
      if (targets.some(item => item.tags.length !== 1 || item.hostname !== 'dispatch')) fail();
      const remaining = before.filter(item => !targets.includes(item)).map(item => item.id).sort();
      const tiers = [null, 7, 30, 90, 365];
      const prefixes = ids.size ? tiers.map(tier => `archives/${tier === null ? 'all' : tier}/`) : [];
      // Prune is necessary on retry even when an earlier attempt already forgot
      // the target snapshot IDs. Restic retains all still-referenced shared data.
      if (ids.size || targets.length) prefixes.push(...['data/', 'index/', 'snapshots/'].map(part => `${config.prefix}/${part}`));
      await storage.withDeletionAccess(prefixes, async () => {
        for (const set of sets.filter(set=>JSON.parse(set.members_json).some(member=>member.organizationId===job.organization_id))) {
          if(!/^breq_[a-f0-9]{32}$/.test(set.id))fail();
          await storage.removeSet(set.id);
          fs.rmSync(path.join(workRoot,`set-${set.id}.json`),{force:true});
        }
        for (const id of ids) for (const retentionDays of tiers) await storage.removePermanent({ id, retentionDays });
        if (targets.length) run(['forget', ...targets.map(item => item.id)]);
        if (ids.size || targets.length) run(['prune', '--max-unused', '0']);
        if (JSON.stringify(snapshots().map(item => item.id).sort()) !== JSON.stringify(remaining)) fail();
        run(['check', '--read-data']);
      });
      for (const row of selected) {
        const file = path.join(workRoot, 'archives', `${row.id}.json`);
        if (fs.existsSync(file)) {
          const receipt = privateJson(file, ownerUid);
          if (receipt.organizationId !== row.organization_id || receipt.id !== row.id) fail();
          atomic(file, { ...receipt, status: 'destroyed', deletedAt: clock() });
        }
      }
      for (const tag of tags) fs.rmSync(path.join(receiptRoot, `${tag}.json`), { force: true });
      // Publish only after every remote deletion and lock restoration succeeds.
      atomic(proofFile, { schemaVersion: 1, status: 'destroyed', jobId: job.id,
        organizationId: job.organization_id, runtimeKey: job.runtime_key, completedAt: clock() }, 0o644);
      fs.chmodSync(proofFile, 0o644);
    } catch { failed++; }
  }
  return { deletedRuntimeKeys, deletingOrganizations, failed };
}
module.exports = { purgeDspBackups, mayContainOrganization };
