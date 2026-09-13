'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unitName } = require('../services/host');
const { assertVolumeMounted } = require('../storage/volume-state');

function counter(root, name) {
  try {
    const value = fs.readFileSync(path.join(root, name), 'utf8').trim();
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  } catch { return null; }
}

// Read only the cgroups belonging to Core's directory identities. Public views
// contain resource values and display names, never unit names or filesystem paths.
function createDirectoryMonitor({ store, manager, paths, execution = null }) {
  return () => {
    const rows = store.db.prepare(`SELECT i.runtime_key,i.status installation_status,o.name FROM installations i JOIN organizations o ON o.id=i.organization_id
      WHERE i.backend='directory_service_v1' ORDER BY o.created_at,o.id`).all();
    const disk = fs.statfsSync(paths.dsps);
    return { enabled: true, storageAvailableBytes: disk.bavail * disk.bsize,
      runtimes: rows.map(row => {
        const record = manager.journal.record(row.runtime_key);
        const group = path.join('/sys/fs/cgroup/system.slice', unitName(row.runtime_key));
        const tasks = counter(group, 'pids.current');
        const worker = execution?.store?.get(row.runtime_key);
        const asleep = worker?.state === 'sleeping' && !(tasks > 0)
          && ['ready', 'waiting_for_owner', 'waiting_for_provider_auth'].includes(row.installation_status);
        let storage = { limited: false, capacityBytes: null, availableBytes: null };
        try {
          const root = path.join(paths.dsps, row.runtime_key), volume = assertVolumeMounted(root);
          if (volume) {
            const usage = fs.statfsSync(path.join(root, 'data'));
            storage = { limited: true, capacityBytes: usage.blocks * usage.bsize, availableBytes: usage.bavail * usage.bsize };
          }
        } catch { storage = { limited: null, capacityBytes: null, availableBytes: null }; }
        return { reference: crypto.createHash('sha256').update(row.runtime_key).digest('hex'), name: row.name,
          status: asleep ? 'sleeping' : record?.desiredState !== 'running' ? tasks > 0 ? 'stopping' : 'stopped'
            : manager.hub.connected(row.runtime_key) ? 'connected' : tasks > 0 ? 'starting' : 'offline',
          memoryBytes: asleep ? 0 : counter(group, 'memory.current'), memoryLimitBytes: counter(group, 'memory.max'), tasks: asleep ? 0 : tasks,
          storage,
        };
      }),
    };
  };
}
module.exports = { createDirectoryMonitor };
