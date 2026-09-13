'use strict';
const path = require('node:path');
// Wakeups are hints after durable commits. Supervised fallback timers recover
// a missed hint; a notification failure must never undo a successful operation.
function wake(workers, { databaseRoot, localRoot = process.env.DISPATCH_LOCAL_ROOT,
  send = require('node:child_process').spawnSync, uid = process.geteuid() } = {}) {
  if (!localRoot || !path.isAbsolute(localRoot) || path.resolve(localRoot) !== localRoot
      || databaseRoot && path.resolve(localRoot, 'data/access-control') !== databaseRoot) return;
  const units = { reconcile: 'dispatch-installation-reconcile.service', core: 'dispatch-platform-update.service' };
  if (!Array.isArray(workers) || workers.some(worker => !units[worker])) return;
  try {
    send('/usr/bin/systemctl', ['--user', '--no-block', 'start', ...new Set(workers.map(worker => units[worker]))], {
      timeout: 3000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` },
    });
  } catch {} // A fallback timer will read the committed queue.
}
function afterCommit(store, workers) {
  store.afterCommit?.(() => {
    if (typeof store.wakeWorkers === 'function') store.wakeWorkers(workers);
    else wake(workers, { databaseRoot: store.paths?.databaseRoot });
  });
}
module.exports = { wake, afterCommit };
