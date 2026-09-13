'use strict';
const path = require('node:path');
const { publicRootJson, RECEIPTS } = require('./offsite-policy');
function backupArchiveStatus() {
  try {
    const catalog = publicRootJson(path.join(RECEIPTS, 'catalog.json'), true, 0, 4 * 1024 * 1024);
    const status = publicRootJson(path.join(RECEIPTS, 'status.json'), true);
    return {
      status:
        status?.status === 'verified' && Date.now() - status.checkedAt < 300000
          ? 'connected'
          : status
            ? 'attention'
            : 'unavailable',
      checkedAt: status?.checkedAt ? new Date(status.checkedAt).toISOString() : null,
      backups: catalog?.backups || {},
      sets: catalog?.sets || {},
      deletions: catalog?.deletions || {},
      usage: catalog?.usage || {status:'unavailable', checkedAt:null},
    };
  } catch {
    return { status: 'attention', backups: {} };
  }
}
module.exports = { backupArchiveStatus };
