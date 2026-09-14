import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { assert } from '../../shared/errors.js';
import { sha256 } from '../../shared/crypto.js';
import { privateDirectory, atomicPrivateWrite } from './paths.js';
import { lockAlive, acquireLock } from './lock.js';
export async function backupState(root: string, destination: string, standalone = false) {
  root = fs.realpathSync(root);
  const dataDirectory = standalone ? 'data' : 'local';
  destination = path.resolve(destination);
  assert(
    destination !== root && !destination.startsWith(root + path.sep),
    'backup_outside_state_required',
  );
  for (const env of ['production', 'preview'])
    assert(
      !lockAlive(path.join(root, dataDirectory, env, 'api.lock')),
      'stop_services_before_backup',
      409,
    );
  const locks: (() => void)[] = [];
  try {
    for (const env of ['production', 'preview'])
      locks.push(acquireLock(path.join(root, dataDirectory, env), 'api'));
    assert(!fs.existsSync(destination), 'backup_destination_exists', 409);
    privateDirectory(destination);
    const files: { path: string; sha256: string; size: number }[] = [];
    async function copy(source: string, relative: string) {
      const info = fs.lstatSync(source);
      assert(!info.isSymbolicLink(), 'backup_symlink_denied');
      if (info.isDirectory()) {
        privateDirectory(path.join(destination, relative));
        for (const name of fs.readdirSync(source))
          if (
            !name.endsWith('-wal') &&
            !name.endsWith('-shm') &&
            !name.endsWith('.lock') &&
            name !== 'browser-runs' &&
            name !== 'releases' &&
            name !== 'activation-staging' &&
            name !== 'activation-backups'
          )
            await copy(path.join(source, name), path.join(relative, name));
      } else if (info.isFile()) {
        const dest = path.join(destination, relative);
        if (source.endsWith('.sqlite')) {
          const db = new DatabaseSync(source, { readOnly: true });
          try {
            await backup(db, dest);
          } finally {
            db.close();
          }
          fs.chmodSync(dest, 0o600);
        } else fs.copyFileSync(source, dest);
        const bytes = fs.readFileSync(dest);
        files.push({ path: relative, sha256: sha256(bytes), size: bytes.length });
      }
    }
    for (const name of ['dsps', dataDirectory])
      if (fs.existsSync(path.join(root, name))) await copy(path.join(root, name), name);
    atomicPrivateWrite(
      path.join(destination, 'backup.json'),
      JSON.stringify({ format: 1, createdAt: new Date().toISOString(), files }, null, 2),
    );
    return { destination, files: files.length };
  } finally {
    for (const unlock of locks.reverse()) unlock();
  }
}
export function restoreState(source: string, target: string) {
  assert(
    !fs.existsSync(target) || fs.readdirSync(target).length === 0,
    'restore_empty_target_required',
    409,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'backup.json'), 'utf8')) as {
    format: number;
    files: { path: string; sha256: string; size: number }[];
  };
  assert(manifest.format === 1 && Array.isArray(manifest.files), 'invalid_backup');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    assert(
      !path.isAbsolute(file.path) &&
        file.path.split(path.sep).every((p) => p && p !== '.' && p !== '..') &&
        ['dsps', 'local', 'data'].includes(file.path.split(path.sep)[0]!) &&
        !seen.has(file.path),
      'invalid_backup_path',
    );
    seen.add(file.path);
    const filename = path.join(source, file.path);
    assert(
      fs.realpathSync(filename) === filename && fs.lstatSync(filename).isFile(),
      'invalid_backup_file',
    );
    const bytes = fs.readFileSync(filename);
    assert(bytes.length === file.size && sha256(bytes) === file.sha256, 'backup_checksum_failed');
  }
  privateDirectory(target);
  for (const file of manifest.files) {
    const dest = path.join(target, file.path);
    privateDirectory(path.dirname(dest));
    fs.copyFileSync(path.join(source, file.path), dest);
    fs.chmodSync(dest, 0o600);
  }
  // Restoring data must never revive old web sessions, invitations or reset links.
  const dataDirectory = fs.existsSync(path.join(target, 'data')) ? 'data' : 'local';
  const accounts = path.join(target, dataDirectory, 'platform', 'accounts.sqlite');
  if (fs.existsSync(accounts)) {
    const db = new DatabaseSync(accounts);
    try {
      db.exec(
        'DELETE FROM sessions; DELETE FROM resets; DELETE FROM invitations; DELETE FROM outbox; DELETE FROM deployment_requests; UPDATE deployments SET digest=NULL; DELETE FROM releases;',
      );
    } finally {
      db.close();
    }
  }
  for (const environment of ['production', 'preview']) {
    const filename = path.join(target, dataDirectory, environment, 'jobs.sqlite');
    if (fs.existsSync(filename)) {
      const db = new DatabaseSync(filename);
      try {
        db.exec(
          "UPDATE jobs SET status='cancelled',message='Cancelled after restore',error='state_restored',lease_owner=NULL,lease_until=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('queued','running','waiting_verification');",
        );
      } finally {
        db.close();
      }
    }
  }
  return { target, files: manifest.files.length };
}
