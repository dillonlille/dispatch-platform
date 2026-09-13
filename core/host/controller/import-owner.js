'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { fail } = require('./operations');

// Narrow migration for an earlier owner-only installation. It deliberately
// refuses a source with tenants: those require an explicit DSP data mapping.
// Password hashes remain private; sessions and pending reset links are not copied.
function importInitialOwner(store, sourceFile) {
  if (!path.isAbsolute(sourceFile) || path.resolve(sourceFile) !== sourceFile || fs.realpathSync(sourceFile) !== sourceFile) fail('directory_import_unsafe');
  const info = fs.lstatSync(sourceFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== 0o600 || info.size > 64 * 1024 ** 2) fail('directory_import_unsafe');
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let owner;
  try {
    source.exec('BEGIN');
    if (source.prepare('SELECT count(*) n FROM organizations').get().n !== 0
        || source.prepare('SELECT count(*) n FROM installations').get().n !== 0) fail('directory_import_mapping_required');
    const users = source.prepare('SELECT * FROM users').all();
    if (users.length !== 1 || users[0].platform_role !== 'owner' || users[0].status !== 'active') fail('directory_import_identity_invalid');
    owner = users[0];
    if (!/^usr_[a-zA-Z0-9_-]+$/.test(owner.id) || typeof owner.password_hash !== 'string'
        || !/^scrypt-v1\$32768\$8\$1\$[A-Za-z0-9_-]{32}\$[A-Za-z0-9_-]{86}$/.test(owner.password_hash)) fail('directory_import_identity_invalid');
  } finally { source.close(); }
  const receipt = `aud_owner_import_${crypto.createHash('sha256').update(owner.id).digest('hex').slice(0, 32)}`;
  return store.transaction(() => {
    const previous = store.db.prepare('SELECT 1 FROM audit_events WHERE id=?').get(receipt);
    if (previous) {
      const user = store.userById(owner.id);
      if (!user || user.platform_role !== 'owner') fail('directory_import_identity_changed');
      return { ok: true, status: 'owner_already_imported' };
    }
    if (store.userById(owner.id) || store.userByEmail(owner.email)) fail('directory_import_identity_conflict');
    const timestamp = Date.now();
    store.insertUser({ id: owner.id, email: owner.email, firstName: owner.first_name, lastName: owner.last_name,
      passwordHash: owner.password_hash, platformRole: 'owner', timestamp });
    store.createAudit({ id: receipt, actorUserId: null, organizationId: null, action: 'platform.owner.import',
      targetType: 'user', targetId: owner.id, result: 'succeeded', timestamp });
    return { ok: true, status: 'owner_imported' };
  });
}

module.exports = { importInitialOwner };
