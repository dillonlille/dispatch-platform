'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { defaultPaths } = require('./paths');
const { CredentialVault } = require('./vault');
const { AttemptGuard } = require('./attempt-guard');
const { PERSISTENT_PROVIDERS, removePersistentProfile } = require('./browser-runtime');
const { resolveRootExecutable } = require('dispatch-protocol/trusted-command-path');
const { PROVIDERS, validateProfile, validateProvider } = require('./providers');
const { acquireMaintenanceLock } = require('./maintenance-lock');
const PERSISTENT_PROVIDER_SET = new Set(PERSISTENT_PROVIDERS);

function persistentProvidersToReset(existingProvider, replacementProvider) {
  return [...new Set([existingProvider, replacementProvider]
    .filter(provider => typeof provider === 'string' && PERSISTENT_PROVIDER_SET.has(provider)))];
}

function parse(argv) {
  const command = argv[0];
  if (command === 'init' || command === 'list' || command === 'verify') {
    if (argv.length !== 1) throw new Error('invalid_request');
    return { command };
  }
  if (['status', 'remove'].includes(command)) {
    if (argv.length !== 2) throw new Error('invalid_request');
    return { command, profile: validateProfile(argv[1]) };
  }
  if (['enroll', 'replace'].includes(command)) {
    if (argv.length !== 3) throw new Error('invalid_request');
    return { command, profile: validateProfile(argv[1]), provider: validateProvider(argv[2]) };
  }
  throw new Error('invalid_request');
}

function setEcho(fd, enabled) {
  const executable = resolveRootExecutable(process.env.DISPATCH_STTY_EXECUTABLE, ['stty']);
  if (!executable) throw new Error('tty_unavailable');
  const args = enabled ? ['echo', 'echonl'] : ['-echo', '-echonl'];
  const result = spawnSync(executable, args, { stdio: [fd, fd, fd] });
  if (result.error || result.status !== 0) throw new Error('tty_unavailable');
}

function hiddenLine(fd, prompt, maximum) {
  fs.writeSync(fd, prompt);
  let echoDisabled = false;
  const restoreOnExit = () => {
    if (!echoDisabled) return;
    try {
      const executable = resolveRootExecutable(process.env.DISPATCH_STTY_EXECUTABLE, ['stty']);
      if (executable) spawnSync(executable, ['echo', 'echonl'], { stdio: [fd, fd, fd] });
    } catch {}
  };
  const onSigInt = () => { restoreOnExit(); process.exit(130); };
  const onSigTerm = () => { restoreOnExit(); process.exit(143); };
  process.once('exit', restoreOnExit);
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);
  const bytes = [];
  const byte = Buffer.alloc(1);
  try {
    setEcho(fd, false);
    echoDisabled = true;
    while (bytes.length <= maximum * 4) {
      const count = fs.readSync(fd, byte, 0, 1, null);
      if (count !== 1) throw new Error('tty_unavailable');
      if (byte[0] === 10 || byte[0] === 13) break;
      bytes.push(byte[0]);
    }
  } finally {
    byte.fill(0);
    if (echoDisabled) setEcho(fd, true);
    echoDisabled = false;
    process.removeListener('exit', restoreOnExit);
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
    fs.writeSync(fd, '\n');
  }
  if (!bytes.length || bytes.length > maximum * 4) {
    bytes.fill(0);
    throw new Error('invalid_input');
  }
  const value = Buffer.from(bytes).toString('utf8');
  bytes.fill(0);
  return value;
}

function collectCredentials(provider) {
  let fd;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error('tty_unavailable');
  }
  const labels = {
    paycom: {
      clientCode: 'Paycom client code',
      username: 'Paycom username',
      password: 'Paycom password',
      pin1: 'Paycom Security PIN 1 (exact configured value)',
      pin2: 'Paycom Security PIN 2 (exact configured value)',
      pin3: 'Paycom Security PIN 3 (exact configured value)',
      pin4: 'Paycom Security PIN 4 (exact configured value)',
      pin5: 'Paycom Security PIN 5 (exact configured value)',
    },
    'amazon-logistics': {
      username: 'Amazon Logistics username',
      password: 'Amazon Logistics password',
    },
  }[provider] || {};
  const values = {};
  try {
    const info = fs.fstatSync(fd);
    if (!info.isCharacterDevice()) throw new Error('tty_unavailable');
    fs.writeSync(fd, 'Secrets are read only from this terminal with echo disabled.\n');
    fs.writeSync(fd, 'Each value must be entered twice to prevent accidental lockouts.\n\n');
    for (const [field, maximum] of PROVIDERS[provider].fields) {
      const label = labels[field] || field;
      const value = hiddenLine(fd, `${label}: `, maximum);
      const confirmation = hiddenLine(fd, `Confirm ${label}: `, maximum);
      if (value !== confirmation) throw new Error('confirmation_mismatch');
      values[field] = value;
    }
    return values;
  } catch (error) {
    for (const field of Object.keys(values)) values[field] = '';
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function requireBrokerStopped(paths) {
  if (fs.existsSync(paths.socket)) throw new Error('broker_running');
}

function scrubRecord(value) {
  if (!value || typeof value !== 'object') return;
  for (const field of Object.keys(value)) value[field] = '';
}

function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  let vault;
  let releaseMaintenance;
  let attemptGuard;
  try {
    const values = parse(argv);
    const paths = defaultPaths();
    if (['init', 'enroll', 'replace', 'remove'].includes(values.command)) {
      releaseMaintenance = acquireMaintenanceLock(paths);
      requireBrokerStopped(paths);
    }
    if (['enroll', 'replace', 'remove'].includes(values.command)) attemptGuard = new AttemptGuard(paths.attempts);
    const readOnly = ['list', 'verify', 'status'].includes(values.command);
    vault = new CredentialVault(paths, { readOnly });
    let result;
    if (values.command === 'init') result = { initialized: true, ...vault.verify() };
    else if (values.command === 'list') result = { profiles: vault.list() };
    else if (values.command === 'verify') result = vault.verify();
    else if (values.command === 'status') result = vault.status(values.profile);
    else if (values.command === 'remove') {
      const existing = vault.status(values.profile);
      if (existing.configured && PERSISTENT_PROVIDER_SET.has(existing.provider)) {
        removePersistentProfile(paths.browserSessions, existing.provider, values.profile);
      }
      result = vault.remove(values.profile);
      if (result.removed) attemptGuard.unlock(values.profile);
    }
    else {
      const existing = vault.status(values.profile);
      if (values.command === 'enroll' && existing.configured) throw new Error('profile_exists');
      if (values.command === 'replace' && !existing.configured) throw new Error('profile_not_configured');
      const credentials = collectCredentials(values.provider);
      try {
        for (const provider of persistentProvidersToReset(
          existing.configured ? existing.provider : null, values.provider,
        )) removePersistentProfile(paths.browserSessions, provider, values.profile);
        result = vault.put(values.profile, values.provider, credentials, { operation: values.command });
        attemptGuard.unlock(values.profile);
      } finally {
        scrubRecord(credentials);
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: true, status: 'ok', ...result })}\n`);
    return 0;
  } catch (error) {
    const safe = new Set(['invalid_request', 'invalid_input', 'confirmation_mismatch', 'profile_exists', 'profile_not_configured', 'profile_limit', 'tty_unavailable', 'vault_integrity_failed', 'unsafe_storage', 'incomplete_storage', 'broker_running', 'maintenance_busy', 'unsafe_maintenance_lock', 'unsafe_browser', 'browser_profile_busy', 'browser_cleanup_failed']);
    const code = safe.has(error?.code) ? error.code : safe.has(error?.message) ? error.message : 'internal_error';
    process.stdout.write(`${JSON.stringify({ ok: false, status: code })}\n`);
    return 1;
  } finally {
    vault?.close();
    releaseMaintenance?.();
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { parse, main, persistentProvidersToReset };
