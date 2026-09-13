'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
// Each archive has its own repository and receipt. The parent scan retains the
// global deletion lock; only independent uploads run in these bounded workers.
async function parallelBackupExports(rows, { concurrency = 3, execute = upload, discover = async () => [],
  pollMs = 500, maxExports = 1000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw Error('invalid_backup_concurrency');
  const results = new Map(), seen = new Set(), queue = [], active = new Set();
  function admit(items) {
    for (const row of items) if (!seen.has(row.id) && seen.size < maxExports) { seen.add(row.id); queue.push(row); }
  }
  admit(rows);
  let discoveryError;
  while (true) {
    // Refresh even while a slow export runs: idle slots must accept snapshots
    // that became ready after this scan started. Deletion stays in the parent.
    try { admit(await discover()); } catch (error) { discoveryError = error; }
    while (!discoveryError && queue.length && active.size < concurrency) {
      const row = queue.shift();
      const task = Promise.resolve().then(() => execute(row.id)).then(
        value => results.set(row.id, {ok:true,value}), () => results.set(row.id, {ok:false})
      ).finally(() => active.delete(task));
      active.add(task);
    }
    if (!active.size) break;
    let timer;
    await Promise.race([...active, new Promise(resolve => { timer = setTimeout(resolve, pollMs); })]);
    clearTimeout(timer);
  }
  // Never release the parent's deletion lock with orphan upload workers.
  await Promise.all(active);
  if (discoveryError) throw discoveryError;
  return results;
}
function upload(backupId) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "./backup-export-worker.js"), { workerData: { backupId }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    let result;
    worker.on('message', value => { result = value; });
    worker.on('error', () => reject(Error('backup_upload_failed')));
    worker.on('exit', code => code === 0 && result?.ok ? resolve(result) : reject(Error('backup_upload_failed')));
  });
}
module.exports = { parallelBackupExports };
