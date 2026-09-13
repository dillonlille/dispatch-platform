'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIONS } = require('./journal');
const { fail } = require('./operations');
const { openDirectoryRuntime } = require('./runtime');

function request(line) {
  if (Buffer.byteLength(line) > 4096) fail('directory_request_invalid');
  let value;
  try { value = JSON.parse(line); } catch { fail('directory_request_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('directory_request_invalid');
  const keys = Object.keys(value).sort().join(',');
  if (value.action === 'list' && keys === 'action') return value;
  if (!ACTIONS.includes(value.action)
      || keys !== (value.action === 'create' ? 'action,requestId' : 'action,dspId,requestId')) fail('directory_request_invalid');
  return value;
}

// Foreground, operator-only control over standard input. The hub and bridges
// stay alive across commands. Closing the controller retains services and data;
// the next controller reconciles their journal before accepting commands.
async function runController({ paths, installation, input = process.stdin, output = process.stdout }) {
  let runtime, lines, store;
  const send = value => output.write(JSON.stringify(value) + '\n');
  const stop = () => lines?.close();
  try {
    const databaseRoot = path.join(paths.local, 'state/access-control');
    const database = path.join(databaseRoot, 'access-control.sqlite3');
    if (fs.existsSync(database)) {
      const { AccessStore } = require('../../core/accounts/src/store');
      store = new AccessStore({ databaseRoot, database }, { readOnly: true });
    }
    const managed = id => Boolean(store?.db.prepare('SELECT 1 FROM installations WHERE runtime_key=?').get(id));
    const { DirectoryJournal } = require('./journal');
    const journal = new DirectoryJournal(paths), local = journal.authorityCatalog();
    runtime = await openDirectoryRuntime({ paths, installation, journal,
      select: record => !managed(record.id),
      authorityCatalog: { resolve: id => managed(id) ? null : local.resolve(id),
        count: () => journal.all().filter(record => !managed(record.id) && local.resolve(record.id)).length },
      networkPermitted: id => !managed(id) });
    const { manager } = runtime;
    lines = readline.createInterface({ input, crlfDelay: Infinity });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    send({ ok: true, status: 'ready' });
    for await (const line of lines) {
      try {
        const value = request(line);
        if (value.dspId && managed(value.dspId)) fail('directory_use_dashboard');
        send(value.action === 'list' ? { ok: true, dsps: manager.list() }
          : await manager.apply(value.action, value.requestId, value.dspId));
      } catch (error) {
        send({ ok: false, status: /^directory_[a-z_]+$/.test(error.code || '') ? error.code : 'directory_operation_failed' });
      }
    }
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    lines?.close();
    try { await runtime?.close(); } finally { store?.close(); }
  }
}

module.exports = { request, runController };
