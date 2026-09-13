'use strict';

const { randomUUID } = require('node:crypto');
const { SYSTEM_ROLES } = require('./permissions');

// Called inside the schema transaction. Keep canonical role IDs and repoint all
// memberships and invitations before deleting retired roles (including custom
// roles whose names collide with the new catalog).
function migrateFixedRoles(db) {
  const timestamp = Date.now();
  for (const organization of db.prepare('SELECT id FROM organizations').all()) {
    const existing = db.prepare('SELECT * FROM roles WHERE organization_id=?').all(organization.id);
    const targets = new Map();
    for (const definition of SYSTEM_ROLES) {
      let role = existing.find(candidate => candidate.key === definition.key);
      if (!role) {
        const id = `role_${randomUUID().replaceAll('-', '')}`;
        db.prepare(`INSERT INTO roles VALUES(?,?,?,?,?,1,NULL,?,?)`).run(
          id, organization.id, definition.key, id, definition.description, timestamp, timestamp,
        );
        role = { id };
      }
      targets.set(definition.key, role.id);
    }
    for (const role of existing) {
      if (targets.get(role.key) === role.id) continue;
      const key = role.key === 'administrator' ? 'manager'
        : role.key === 'viewer' ? 'driver'
          : SYSTEM_ROLES.find(definition => definition.name.toLowerCase() === role.name.trim().toLowerCase())?.key || 'dispatcher';
      const target = targets.get(key);
      db.prepare('UPDATE memberships SET role_id=?,updated_at=? WHERE organization_id=? AND role_id=?')
        .run(target, timestamp, organization.id, role.id);
      // Preserve tokens, expiry, status, and acceptance history.
      db.prepare('UPDATE invitations SET role_id=? WHERE organization_id=? AND role_id=?')
        .run(target, organization.id, role.id);
      db.prepare('DELETE FROM roles WHERE id=?').run(role.id);
    }
    for (const definition of SYSTEM_ROLES) {
      const roleId = targets.get(definition.key);
      db.prepare('UPDATE roles SET name=?,description=?,is_system=1,updated_at=? WHERE id=?')
        .run(definition.name, definition.description, timestamp, roleId);
      db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(roleId);
      for (const permission of definition.permissions) {
        db.prepare('INSERT INTO role_permissions VALUES(?,?)').run(roleId, permission);
      }
    }
  }
}

module.exports = { migrateFixedRoles };
