'use strict';

const fs = require('node:fs'), path = require('node:path');
const { loadPlatformPaths } = require('../../shared/paths/platform-paths');
const { AccessStore } = require('../../core/accounts/src/store');
const { verifyPassword } = require('../../core/accounts/src/passwords');
const { email, exact } = require('../../core/accounts/src/validation');
const { ManualBackups } = require('./manual-backups');
const { fail } = require('../controller/operations');
const files = require('./backup-files');

async function readInput() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > 4096) fail('directory_request_invalid');
  }
  return JSON.parse(value);
}

async function main(argv, { paths, read = readInput, write = value => process.stdout.write(value) } = {}) {
  let store, input;
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      write('Usage: dispatch-local-backup list | backup | restore | resume REQUEST_ID\n'
        + 'Set DISPATCH_PLATFORM_CONFIG to the private platform configuration.\n'
        + 'Suspend affected DSPs and stop the dashboard before backup or restore.\n'
        + 'For backup/restore, provide JSON on standard input with email, password, scope (platform or dsp), and requestId (16–128 characters).\n'
        + 'DSP scope also requires organizationId and expectedRevision. Restore also requires backupId and confirmRestore: true.\n'
        + 'Resume continues only an existing owner-authorized request. No scheduled or automatic backups run.\n');
      return 0;
    }
    paths ||= loadPlatformPaths();
    const [action, requestId] = argv;
    if (!(argv.length === 1 && ['list', 'backup', 'restore'].includes(action)
        || argv.length === 2 && action === 'resume')) fail('directory_request_invalid');
    const databaseRoot = path.join(paths.local, 'state/access-control'), database = path.join(databaseRoot, 'access-control.sqlite3');
    files.checked(database, false); // Never initialize a different Core by accident.
    store = new AccessStore({ databaseRoot, database });
    const backups = new ManualBackups({ paths, store });
    if (action === 'list') { write(JSON.stringify({ ok: true, ...backups.view() }) + '\n'); return 0; }
    let id = requestId;
    if (action !== 'resume') {
      input = await read();
      exact(input, ['email', 'password', 'scope', 'organizationId', 'expectedRevision', 'backupId', 'requestId', 'confirmRestore']);
      const owner = store.userByEmail(email(input.email));
      if (!owner || owner.platform_role !== 'owner' || owner.status !== 'active'
          || typeof input.password !== 'string' || !await verifyPassword(input.password, owner.password_hash)) fail('directory_backup_owner_required');
      id = backups.request(owner.id, { action, scope: input.scope, organizationId: input.organizationId ?? null,
        expectedRevision: input.expectedRevision ?? null, backupId: input.backupId ?? null,
        requestId: input.requestId, confirmRestore: input.confirmRestore === true });
    }
    // Resume consumes only the already authorized, private owner request. It
    // cannot create a new restore or require credentials from a half-restored Core.
    const job = await backups.resume(id);
    write(JSON.stringify({ ok: job.status === 'complete', requestId: id, backupId: job.backupId,
      status: job.status, failure: job.failure }) + '\n');
    return job.status === 'complete' ? 0 : 1;
  } catch (error) {
    const code = error.code || error.message;
    write(JSON.stringify({ ok: false, status: /^(directory_|backup_requires_|installation_|idempotency_)[a-z_]+$/.test(code || '')
      ? code : 'directory_backup_failed' }) + '\n');
    return 1;
  } finally {
    if (input) for (const key of Object.keys(input)) input[key] = null;
    store?.close();
  }
}
module.exports = { main, readInput };
