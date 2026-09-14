import fs from 'node:fs';
import path from 'node:path';
import { id } from '../../shared/crypto.js';
import { assert } from '../../shared/errors.js';
import { privateFile, privateDirectory } from './paths.js';
function birth(pid: number) {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}
interface Lock {
  pid: number;
  birth: string;
  owner: string;
}
export function lockAlive(file: string) {
  if (!fs.existsSync(file)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(privateFile(file), 'utf8')) as Lock;
    return Boolean(value.birth && birth(value.pid) === value.birth);
  } catch {
    return true;
  }
}
export function acquireLock(directory: string, name: string) {
  privateDirectory(directory);
  const file = path.join(directory, `${name}.lock`);
  const value: Lock = { pid: process.pid, birth: birth(process.pid)!, owner: id('lock') };
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Lock;
          if (current.owner === value.owner) fs.unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assert(!lockAlive(file), 'service_already_running', 409);
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  throw new Error('lock_unavailable');
}
