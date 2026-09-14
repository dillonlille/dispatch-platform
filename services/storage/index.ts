import path from 'node:path';
import type { Config } from '../config.js';
import { Paths, keyFile } from './paths.js';
import { Database } from './database.js';
import { platformSchema, dspSchema, jobSchema } from './schema.js';
export class Storage {
  readonly paths: Paths;
  readonly platform: Database;
  readonly jobs: Database;
  readonly key: Buffer;
  constructor(readonly config: Config) {
    this.paths = new Paths(config.stateRoot, config.standalone);
    this.key = keyFile(path.join(this.paths.platform, 'platform.key'));
    this.platform = new Database(
      path.join(this.paths.platform, 'accounts.sqlite'),
      platformSchema,
      config.standalone || config.environment === 'production',
    );
    this.jobs = new Database(
      path.join(this.paths.environment(config.environment), 'jobs.sqlite'),
      jobSchema,
    );
  }
  dsp<T>(id: string, fn: (db: Database) => T): T {
    const db = new Database(
      path.join(this.paths.dspArea(id, 'data'), 'dispatch.sqlite'),
      dspSchema,
    );
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  close() {
    this.jobs.close();
    this.platform.close();
  }
}
