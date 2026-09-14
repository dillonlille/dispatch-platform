import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../shared/errors.js';
export const DSP_ID = /^dsp_[a-f0-9]{32}$/;
export function privateDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const info = fs.lstatSync(cursor);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'unsafe_storage_path');
  }
  const info = fs.statSync(absolute);
  assert(
    info.uid === process.getuid?.() && (info.mode & 0o077) === 0,
    'private_storage_permissions_required',
  );
  return absolute;
}
export function privateFile(file: string, create = false): string {
  privateDirectory(path.dirname(file));
  if (create && !fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat) {
    assert(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o077) === 0,
      'unsafe_storage_file',
    );
  }
  return file;
}
export function atomicPrivateWrite(file: string, value: string | Buffer) {
  privateDirectory(path.dirname(file));
  privateFile(file);
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
export function keyFile(file: string) {
  privateDirectory(path.dirname(file));
  try {
    fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = fs.readFileSync(privateFile(file));
  assert(key.length === 32, 'invalid_key');
  return key;
}
export class Paths {
  readonly root: string;
  readonly platform: string;
  constructor(root: string) {
    this.root = privateDirectory(root);
    this.platform = privateDirectory(path.join(root, 'local', 'platform'));
    privateDirectory(path.join(root, 'dsps'));
  }
  environment(environment: 'preview' | 'production') {
    return privateDirectory(path.join(this.root, 'local', environment));
  }
  dsp(id: string) {
    assert(DSP_ID.test(id), 'invalid_dsp_id');
    return privateDirectory(path.join(this.root, 'dsps', id));
  }
  dspArea(id: string, area: 'config' | 'data' | 'secrets' | 'state') {
    return privateDirectory(path.join(this.dsp(id), area));
  }
  profile(id: string) {
    return privateDirectory(path.join(this.dspArea(id, 'state'), 'browsers', 'paycom'));
  }
}
