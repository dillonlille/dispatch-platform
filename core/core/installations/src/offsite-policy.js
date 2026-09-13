'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const POLICY = '/etc/dispatch/offsite-backup-policy.json';
const RECEIPTS = '/var/lib/dispatch-backup-receipts';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function publicRootJson(file, optional = false, uid = 0, maxBytes = 16384) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > maxBytes
      || fs.realpathSync(file) !== file) fail('offsite_backup_unavailable');
  return JSON.parse(fs.readFileSync(file));
}
function receiptKey(directory) { return crypto.createHash('sha256').update(directory).digest('hex'); }
function hasVerifiedReceipt(directory, digest, { root = RECEIPTS, uid = 0, recoveryRequired = false } = {}) {
  const receipt = publicRootJson(path.join(root, receiptKey(directory) + '.json'), true, uid);
  return Boolean(receipt && receipt.schemaVersion === 1 && receipt.status === 'verified'
    && receipt.digest === digest && /^[a-f0-9]{64}$/.test(receipt.snapshotId)
    && Number.isSafeInteger(receipt.verifiedAt) && receipt.verifiedAt > 0
    && (!recoveryRequired || /^[a-f0-9]{64}$/.test(receipt.recoveryDigest)));
}
function createOffsitePolicy({ policyFile = POLICY, receiptRoot = RECEIPTS, uid = 0,
  clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  function offsiteRequired() {
    const policy = publicRootJson(policyFile, true, uid);
    if (!policy) return false;
    if (policy.schemaVersion !== 1 || policy.required !== true) fail('offsite_backup_unavailable');
    return true;
  }
  function assertOffsiteReady() {
    if (!offsiteRequired()) return;
    const status = publicRootJson(path.join(receiptRoot, 'status.json'), true, uid);
    if (!status || status.status !== 'verified' || !Number.isSafeInteger(status.checkedAt)
        || clock() - status.checkedAt > 300_000 || status.checkedAt > clock() + 5000) fail('offsite_backup_unavailable');
  }
  async function waitForOffsiteBackup(directory, digest, renew = () => {}, { required = false, recoveryRequired = false } = {}) {
    if (!required && !offsiteRequired()) return;
    if (!/^[a-f0-9]{64}$/.test(digest)) fail('offsite_backup_unavailable');
    require('./worker-notify').exportReady();
    const deadline = clock() + (recoveryRequired ? 3600000 : 300000);
    while (!hasVerifiedReceipt(directory, digest, { root: receiptRoot, uid, recoveryRequired })) {
      renew();
      if (clock() >= deadline) fail('offsite_backup_unavailable');
      await sleep(2000);
    }
  }
  async function waitForDspBackupDeletion(jobId, organizationId, runtimeKey, renew = () => {}, { required = false } = {}) {
    if (!required && !offsiteRequired()) return;
    if (!/^[a-z][a-z0-9_-]{2,95}$/.test(jobId)) fail('offsite_backup_unavailable');
    const deadline = clock() + 3_600_000;
    while (true) {
      const proof = publicRootJson(path.join(receiptRoot, `deleted-${jobId}.json`), true, uid);
      if (proof?.schemaVersion === 1 && proof.status === 'destroyed' && proof.jobId === jobId
          && proof.organizationId === organizationId && proof.runtimeKey === runtimeKey) return;
      renew();
      if (clock() >= deadline) fail('offsite_backup_unavailable');
      await sleep(2000);
    }
  }
  return { offsiteRequired, assertOffsiteReady, waitForOffsiteBackup, waitForDspBackupDeletion };
}
module.exports = { ...createOffsitePolicy(), createOffsitePolicy, hasVerifiedReceipt, receiptKey, publicRootJson, RECEIPTS, POLICY };
