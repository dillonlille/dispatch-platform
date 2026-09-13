'use strict';

// Apply business details only after infrastructure provisioning releases its authority.
// The organization's ID, runtime key, host allocation and data paths never change.
function applyOrganizationProfiles(store, clock = Date.now) {
  return store.transaction(() => {
    const rows = store.db.prepare(`SELECT p.* FROM organization_profiles p JOIN installations i ON i.organization_id=p.organization_id
      JOIN organizations o ON o.id=p.organization_id WHERE p.details_json IS NOT NULL AND p.applied_at IS NULL
      AND i.status IN ('waiting_for_owner','waiting_for_provider_auth') AND o.status!='suspended'
      AND i.setup_worker_id IS NULL`).all();
    for (const row of rows) {
      const details = JSON.parse(row.details_json);
      store.db.prepare('UPDATE organizations SET name=?,abbreviation=?,timezone=?,updated_at=? WHERE id=?')
        .run(details.name, details.abbreviation, details.timezone, clock(), row.organization_id);
      store.db.prepare('DELETE FROM stations WHERE organization_id=?').run(row.organization_id);
      store.insertStation(row.organization_id, details.stationCode, true, clock());
      store.db.prepare('UPDATE organization_profiles SET applied_at=? WHERE organization_id=?').run(clock(), row.organization_id);
    }
    require('./workspace-readiness').completeWorkspaceSetup(store, clock);
    return rows.length;
  });
}
module.exports = { applyOrganizationProfiles };
