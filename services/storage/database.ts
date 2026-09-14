import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { privateFile } from './paths.js';
import { assert } from '../../shared/errors.js';
export class Database {
  readonly db: DatabaseSync;
  constructor(
    public readonly filename: string,
    migrations: readonly string[],
    allowMigrations = true,
  ) {
    privateFile(filename, true);
    this.db = new DatabaseSync(filename);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
    );
    const current = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
    assert(current <= migrations.length, 'newer_database_schema', 409);
    assert(
      allowMigrations || current === migrations.length,
      'shared_schema_migration_requires_production',
      409,
    );
    if (current < migrations.length)
      this.transaction(() => {
        const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
        assert(version <= migrations.length, 'newer_database_schema', 409);
        for (let i = version; i < migrations.length; i++) {
          this.db.exec(migrations[i]!);
          this.db.exec(`PRAGMA user_version=${i + 1}`);
        }
      });
  }
  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
