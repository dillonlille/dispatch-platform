'use strict';

const { managedInstallationContext } = require('../../core/accounts/src/installation-authority');

// Directory provisioning already establishes infrastructure readiness. Seed only
// explicitly requested diagnostic DSPs, without manufacturing provider evidence
// or starting a provider schedule. Their egress authority is always disabled.
function createDirectoryDiagnostics({ store, invoke }) {
  const context = id => managedInstallationContext(store, id, { backend: 'directory_service_v1' });
  return { async runPending() {
    const rows = store.db.prepare(`SELECT d.organization_id FROM diagnostic_dsps d JOIN installations i ON i.organization_id=d.organization_id
      JOIN organizations o ON o.id=i.organization_id WHERE d.status='pending' AND i.backend='directory_service_v1'
      AND i.status='ready' AND o.status='active' ORDER BY d.created_at LIMIT 20`).all();
    for (const row of rows) {
      const before = context(row.organization_id);
      let status = 'failed';
      try {
        const result = await invoke(before.installation.runtimeKey, 'diagnostics.seed', { requestId: row.organization_id });
        if (result?.ok && result.status === 'succeeded' && result.data?.roster?.publicationId
            && result.data?.timecards?.publicationId) status = 'ready';
      } catch {}
      store.transaction(() => {
        const current = context(row.organization_id);
        if (current.installation.revision !== before.installation.revision || current.installation.status !== 'ready'
            || current.organization.status !== 'active' || current.installation.runtimeKey !== before.installation.runtimeKey) return;
        store.db.prepare("UPDATE diagnostic_dsps SET status=? WHERE organization_id=? AND status='pending'").run(status, row.organization_id);
      });
    }
  } };
}
module.exports = { createDirectoryDiagnostics };
