import fs from 'node:fs';
import path from 'node:path';
import type { Storage } from '../storage/index.js';
import { atomicPrivateWrite, keyFile, privateFile } from '../storage/paths.js';
import { encrypt, decrypt } from '../../shared/crypto.js';
import { assert } from '../../shared/errors.js';
export interface Credentials {
  clientCode: string;
  username: string;
  password: string;
  securityAnswers?: string[];
}
export class Vault {
  constructor(private storage: Storage) {}
  save(dspId: string, credentials: Credentials) {
    const directory = this.storage.paths.dspArea(dspId, 'secrets');
    const key = keyFile(path.join(directory, 'vault.key'));
    atomicPrivateWrite(
      path.join(directory, 'paycom.enc'),
      encrypt(key, credentials, `${dspId}:paycom:1`),
    );
  }
  read(dspId: string): Credentials {
    const directory = this.storage.paths.dspArea(dspId, 'secrets');
    const file = path.join(directory, 'paycom.enc');
    assert(fs.existsSync(file), 'credentials_required', 409);
    const key = keyFile(path.join(directory, 'vault.key'));
    return decrypt<Credentials>(
      key,
      fs.readFileSync(privateFile(file), 'utf8'),
      `${dspId}:paycom:1`,
    );
  }
  remove(dspId: string) {
    const file = path.join(this.storage.paths.dspArea(dspId, 'secrets'), 'paycom.enc');
    if (fs.existsSync(file)) fs.unlinkSync(privateFile(file));
  }
}
