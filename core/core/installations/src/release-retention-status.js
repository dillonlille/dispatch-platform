'use strict';
const path = require('node:path');
const { RECEIPTS, publicRootJson } = require('./offsite-policy');
function cleanupReady(rolloutId, releaseId, { root = RECEIPTS, uid = 0 } = {}) {
  if (!/^rollout_[a-f0-9]{32}$/.test(rolloutId) || !/^[a-z][a-z0-9_.-]{2,95}$/.test(releaseId)) return false;
  const receipt = publicRootJson(path.join(root, `${rolloutId}.cleanup.json`), true, uid);
  return receipt?.schemaVersion === 1 && receipt.status === 'completed' && receipt.rolloutId === rolloutId && receipt.releaseId === releaseId;
}
module.exports = { cleanupReady };
