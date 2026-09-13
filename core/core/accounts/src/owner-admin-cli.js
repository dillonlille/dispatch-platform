'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveAccessPaths } = require('../../../shared/paths/access-paths');
const { AccessStore } = require('./store');
const { administerOwner, listOwners } = require('./owner-admin');

function collectOwnerInput(action) {
  let fd;
  try { fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NOFOLLOW); }
  catch { throw new Error('tty_required'); }
  let savedMode;
  const stty = args => {
    const result = spawnSync('/usr/bin/stty', args, { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error('tty_required');
    return result.stdout.trim();
  };
  const restore = () => { if (savedMode) { try { stty([savedMode]); } catch {} } };
  const interrupt = () => { restore(); process.exit(130); };
  const terminate = () => { restore(); process.exit(143); };
  const input = {};
  try {
    if (!fs.fstatSync(fd).isCharacterDevice()) throw new Error('tty_required');
    savedMode = stty(['-g']);
    process.once('exit', restore); process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    stty(['-echo', '-echonl']);
    fs.writeSync(fd, 'Enter platform login details privately. Input is hidden.\n');
    if (action === 'owner-recover') fs.writeSync(fd, 'Recovery replaces the login credentials and signs out all sessions.\n');
    const fields = action === 'owner-create'
      ? [['email', 'Owner email', 254], ['firstName', 'First name', 80], ['lastName', 'Last name', 80]]
      : [['email', 'Current owner email', 254], ['newEmail', 'New owner email (Enter to keep current)', 254]];
    fields.push(['password', 'New password (12–128 characters)', 128], ['confirmPassword', 'Confirm new password', 128]);
    for (const [key, label, maximum] of fields) {
      fs.writeSync(fd, `${label}: `);
      const bytes = Buffer.alloc(maximum * 4 + 1);
      let length = 0;
      try {
        while (true) {
          if (length >= bytes.length || fs.readSync(fd, bytes, length, 1, null) !== 1) throw new Error('input_cancelled');
          if (bytes[length] === 10 || bytes[length] === 13) break;
          length += 1;
        }
        input[key] = bytes.subarray(0, length).toString('utf8');
      } finally { bytes.fill(0); fs.writeSync(fd, '\n'); }
    }
    return input;
  } finally {
    restore();
    process.removeListener('exit', restore); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    fs.closeSync(fd);
  }
}

async function main(argv, { paths = resolveAccessPaths(), collect = collectOwnerInput,
  write = value => process.stdout.write(value) } = {}) {
  const [action] = argv;
  if (argv.length !== 1 || !['owner-create', 'owner-recover', 'owner-list'].includes(action)) {
    write('Invalid arguments. Use owner-create, owner-recover, or owner-list without credential arguments.\n');
    return 2;
  }
  let store;
  let input;
  try {
    // Recovery/listing must never silently initialize a different database.
    if (action !== 'owner-create' && !fs.existsSync(paths.accessControl.database)) throw new Error('access_not_initialized');
    if (action !== 'owner-list') input = collect(action);
    if (action === 'owner-create') fs.mkdirSync(path.dirname(paths.accessControl.databaseRoot), { recursive: true, mode: 0o700 });
    store = new AccessStore(paths.accessControl);
    const data = action === 'owner-list' ? { owners: listOwners(store) } : await administerOwner(store, action, input);
    write(`${JSON.stringify({ ok: true, ...data })}\n`);
    return 0;
  } catch (error) {
    const safe = new Set(['tty_required', 'input_cancelled', 'access_not_initialized', 'invalid_input', 'password_policy_failed',
      'password_confirmation_mismatch', 'platform_owner_exists', 'platform_owner_not_found', 'email_in_use', 'account_changed',
      'unsafe_access_storage', 'access_schema_incompatible']);
    const code = error?.code || error?.message;
    write(`${JSON.stringify({ ok: false, status: safe.has(code) ? code : 'owner_admin_failed' })}\n`);
    return 1;
  } finally {
    if (input) for (const key of Object.keys(input)) input[key] = '';
    store?.close();
  }
}

module.exports = { main, collectOwnerInput };
