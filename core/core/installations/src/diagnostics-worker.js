'use strict';

const { activateSyntheticDsp } = require('./diagnostics-activation');

function createDiagnosticsWorker({ store, invoke, activate = activateSyntheticDsp }) {
  async function runPending(workerId, limit = 20) {
    const rows = store.db.prepare(`SELECT d.*,i.status AS installation_status FROM diagnostic_dsps d
      JOIN installations i ON i.organization_id=d.organization_id JOIN organizations o ON o.id=d.organization_id
      WHERE d.status='pending' AND i.backend='native_service_v1' AND o.status!='suspended'
      AND i.status IN ('waiting_for_provider_auth','verifying','ready','failed') ORDER BY d.created_at LIMIT ?`).all(limit);
    let completed = 0, failed = 0;
    for (const [index, row] of rows.entries()) {
      let status = 'failed';
      try {
        if (row.installation_status !== 'failed') {
          const result = await activate({ store, organizationId: row.organization_id, workerId: `${workerId}_${index}`, invoke });
          if (result.ok) status = 'ready';
          else if (result.status === 'installation_operation_in_progress') continue;
        }
      } catch (error) {
        if (error.code === 'installation_operation_in_progress') continue;
      }
      store.db.prepare("UPDATE diagnostic_dsps SET status=? WHERE organization_id=? AND status='pending'")
        .run(status, row.organization_id);
      if (status === 'ready') completed += 1; else failed += 1;
    }
    return { processed: rows.length, completed, failed };
  }
  return { runPending };
}
module.exports = { createDiagnosticsWorker };
