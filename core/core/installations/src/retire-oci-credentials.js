'use strict';

// Repeated after reconciliation so a crash between durable retirement and file
// deletion cannot leave a usable registration credential behind.
function retireOciCredentials({ store, credentialPort }) {
  const rows = store.db.prepare(`SELECT i.runtime_key,a.token_hash,i.organization_id,i.backend FROM installations i
    LEFT JOIN runtime_agent_authorities a ON i.organization_id=a.organization_id AND i.runtime_key=a.runtime_key
    WHERE i.backend IN ('oci_container_v1','native_service_v1') AND i.status='decommissioned'
    AND (a.status='revoked' OR (a.runtime_key IS NULL AND i.backend='native_service_v1' AND EXISTS
      (SELECT 1 FROM installation_lifecycle_jobs j WHERE j.organization_id=i.organization_id AND j.operation='destroy' AND j.status='succeeded')))`).all();
  let removed = 0;
  for (const row of rows) {
    if (credentialPort.revoke(row.runtime_key, row.token_hash)) removed += 1;
    else {
      // Missing is the successful replay case; a changed credential is a conflict.
      try { credentialPort.read(row.runtime_key); }
      catch (error) { if (error?.code !== 'ENOENT') throw error;
        if (row.backend === 'native_service_v1' && store.db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE organization_id=? AND operation='destroy' AND status='succeeded'").get(row.organization_id)) store.eraseOrganization(row.organization_id);
        continue;
      }
      throw Object.assign(new Error('runtime_agent_authority_conflict'), { code: 'runtime_agent_authority_conflict' });
    }
    if (row.backend === 'native_service_v1' && store.db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE organization_id=? AND operation='destroy' AND status='succeeded'").get(row.organization_id)) store.eraseOrganization(row.organization_id);
  }
  return removed;
}
module.exports = { retireOciCredentials };
