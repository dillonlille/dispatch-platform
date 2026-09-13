'use strict';

// Shared by the live account store and retained Core snapshots. Discover foreign
// keys so newly added tenant tables cannot silently escape deletion.
function eraseDsp(db, { organizationId, runtimeKey }) {
  if (!/^org_[a-zA-Z0-9_]+$/.test(organizationId) || !/^dsp_[a-f0-9]{32}$/.test(runtimeKey)) throw Error('invalid_erasure_identity');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  if (tables.some(name => !/^[a-z_]+$/.test(name))) throw Error('erasure_schema_unsupported');
  const columns = new Map(tables.map(name => [name, db.prepare(`PRAGMA table_info("${name}")`).all()]));
  const links = [];
  for (const child of tables) {
    const groups = new Map();
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${child}")`).all()) {
      if (!groups.has(fk.id)) groups.set(fk.id, []);
      groups.get(fk.id).push(fk);
    }
    for (const group of groups.values()) {
      const parent = group[0].table;
      if (!columns.has(parent)) throw Error('erasure_schema_unsupported');
      const keys = columns.get(parent).filter(c => c.pk).sort((a, b) => a.pk - b.pk);
      const join = group.sort((a, b) => a.seq - b.seq).map((fk, i) => {
        const to = fk.to || keys[i]?.name;
        if (![fk.from, to].every(name => /^[a-z_]+$/.test(name))) throw Error('erasure_schema_unsupported');
        return `c."${fk.from}"=p."${to}"`;
      }).join(' AND ');
      links.push({ child, parent, join });
    }
  }
  db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON; CREATE TEMP TABLE erasure_rows(table_name TEXT,row_id INTEGER,PRIMARY KEY(table_name,row_id));');
  try {
    const seed = (table, condition, ...args) => db.prepare(`INSERT OR IGNORE INTO erasure_rows SELECT ?,rowid FROM "${table}" WHERE ${condition}`).run(table, ...args);
    for (const table of tables) {
      const names = columns.get(table).map(c => c.name);
      for (const key of ['organization_id', 'active_organization_id']) if (names.includes(key)) seed(table, `"${key}"=?`, organizationId);
      if (names.includes('runtime_key')) seed(table, 'runtime_key=?', runtimeKey);
      if (names.includes('scope')) seed(table, 'scope IN (?,?)', organizationId, `dsp:${organizationId}`);
      if (table === 'audit_events') seed(table, 'target_id IN (?,?)', organizationId, runtimeKey);
    }
    seed('organizations', 'id=?', organizationId);
    const expand = () => {
      let changed;
      do {
        changed = 0;
        for (const { child, parent, join } of links) changed += db.prepare(`INSERT OR IGNORE INTO erasure_rows
          SELECT ?,c.rowid FROM "${child}" c JOIN "${parent}" p ON ${join}
          JOIN erasure_rows e ON e.table_name=? AND e.row_id=p.rowid`).run(child, parent).changes;
      } while (changed);
    };
    expand();
    // Platform users and accounts referenced by another DSP remain independent
    // identities. Remove accounts that existed only for the erased DSP.
    const candidates = db.prepare(`SELECT DISTINCT u.* FROM users u JOIN memberships m ON m.user_id=u.id
      WHERE m.organization_id=? AND u.platform_role IS NULL`).all(organizationId);
    const privateChildren = new Set(['sessions', 'password_reset_tokens', 'release_popup_dismissals', 'audit_events', 'platform_target_refs', 'platform_mutation_requests']);
    const removedUsers = [];
    for (const user of candidates) {
      const userRow = db.prepare('SELECT rowid FROM users WHERE id=?').get(user.id).rowid;
      const shared = links.filter(link => link.parent === 'users').some(({ child, join }) => {
        const names = columns.get(child).map(c => c.name);
        if (privateChildren.has(child) && !names.includes('organization_id')) return false;
        const scope = privateChildren.has(child) ? ' AND c.organization_id IS NOT NULL AND c.organization_id<>?' : '';
        return Boolean(db.prepare(`SELECT 1 FROM "${child}" c JOIN users p ON ${join} WHERE p.rowid=?
          AND NOT EXISTS(SELECT 1 FROM erasure_rows e WHERE e.table_name=? AND e.row_id=c.rowid)${scope} LIMIT 1`)
          .get(userRow, child, ...(scope ? [organizationId] : [])));
      });
      if (!shared) { seed('users', 'id=?', user.id); removedUsers.push(user.id); }
    }
    expand();
    for (const table of tables) db.prepare(`DELETE FROM "${table}" WHERE rowid IN (SELECT row_id FROM erasure_rows WHERE table_name=?)`).run(table);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('erasure_integrity_failed');
    db.exec('DROP TABLE erasure_rows; COMMIT');
    return { removedUsers };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function compactErasedDatabase(db) {
  db.exec('PRAGMA secure_delete=ON; VACUUM');
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (checkpoint.busy) throw Error('erasure_checkpoint_busy');
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('erasure_integrity_failed');
}
module.exports = { eraseDsp, compactErasedDatabase };
