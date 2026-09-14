import type { Storage } from '../storage/index.js';
import type { Audit } from '../audit/index.js';
import type { Dsp, Connection } from '../../shared/contracts/index.js';
import type { Credentials } from './vault.js';
import { Vault } from './vault.js';
import { BrowserManager, type BrowserSession } from '../browsers/manager.js';
import { assert, safeError } from '../../shared/errors.js';
export class AuthBroker {
  readonly vault: Vault;
  constructor(
    readonly storage: Storage,
    readonly audit: Audit,
    readonly browsers: BrowserManager,
  ) {
    this.vault = new Vault(storage);
  }
  connection(dspId: string): Connection {
    return this.storage.dsp(dspId, (db) => {
      const row = db.one<{
        enabled: number;
        status: Connection['status'];
        error: string | null;
        updated_at: string;
        verified_at: string | null;
        account_label: string | null;
      }>("SELECT * FROM connections WHERE provider='paycom'")!;
      return {
        provider: 'paycom',
        enabled: Boolean(row.enabled),
        status: row.status,
        error: row.error,
        updatedAt: row.updated_at,
        lastVerifiedAt: row.verified_at,
        accountLabel: row.account_label,
      };
    });
  }
  private state(dspId: string, status: Connection['status'], error: string | null = null) {
    this.storage.dsp(dspId, (db) =>
      db.run(
        "UPDATE connections SET status=?,error=?,updated_at=?,verified_at=CASE WHEN ?='ready' THEN ? ELSE verified_at END WHERE provider='paycom'",
        status,
        error,
        new Date().toISOString(),
        status,
        new Date().toISOString(),
      ),
    );
  }
  async save(dsp: Dsp, credentials: Credentials, actorId: string, guard: () => void = () => {}) {
    await this.browsers.revoke(dsp.id);
    guard();
    this.vault.save(dsp.id, credentials);
    this.storage.dsp(dsp.id, (db) =>
      db.run(
        "UPDATE connections SET enabled=1,status='not_connected',error=NULL,account_label=?,verified_at=NULL,revision=revision+1,updated_at=? WHERE provider='paycom'",
        credentials.clientCode,
        new Date().toISOString(),
      ),
    );
    // A profile belongs to a credential generation. A replacement never reuses
    // an authenticated profile for a potentially different provider account.
    const fs = await import('node:fs');
    guard();
    const profile = this.storage.paths.profile(dsp.id);
    fs.rmSync(profile, { recursive: true, force: true });
    this.audit.record(actorId, dsp.id, 'connection.credentials_saved');
    return this.ensure(dsp, true);
  }
  async ensure(dsp: Dsp, ownerRetry = false): Promise<BrowserSession> {
    const connection = this.connection(dsp.id);
    assert(connection.enabled, 'connection_required', 409);
    const existing = this.browsers.sessions.get(dsp.id);
    if (existing && existing.status !== 'closed') {
      assert(existing.status !== 'starting', 'connection_busy', 409);
      if (ownerRetry) {
        assert(!existing.busy, 'connection_busy', 409);
        this.state(dsp.id, 'signing_in');
        try {
          await existing.check(this.vault.read(dsp.id));
          this.state(dsp.id, existing.status === 'ready' ? 'ready' : 'needs_verification');
        } catch (error) {
          await existing.close();
          this.state(dsp.id, 'error', safeError(error));
          throw error;
        }
      }
      return existing;
    }
    this.state(dsp.id, 'signing_in');
    try {
      const session = await this.browsers.acquire(
        dsp,
        this.vault.read(dsp.id),
        undefined,
        ownerRetry,
      );
      this.state(dsp.id, session.status === 'ready' ? 'ready' : 'needs_verification');
      session.on('event', (event) => {
        if (event.type === 'ready') this.state(dsp.id, 'ready');
        if (event.type === 'challenge') this.state(dsp.id, 'needs_verification');
      });
      session.once('closed', () => {
        if (this.connection(dsp.id).status === 'needs_verification')
          this.state(dsp.id, 'error', 'verification_expired');
      });
      return session;
    } catch (error) {
      this.state(dsp.id, 'error', safeError(error));
      throw error;
    }
  }
  async verify(dsp: Dsp, code: string, actorId: string) {
    const session = this.browsers.sessions.get(dsp.id);
    assert(session, 'verification_expired', 409);
    await session.verify(code);
    this.audit.record(actorId, dsp.id, 'connection.verification_submitted');
    return this.connection(dsp.id);
  }
  async disable(dspId: string, actorId: string, removeCredentials = false) {
    await this.browsers.revoke(dspId);
    this.storage.dsp(dspId, (db) =>
      db.transaction(() => {
        db.run(
          "UPDATE connections SET enabled=0,status='not_connected',error=NULL,revision=revision+1,updated_at=? WHERE provider='paycom'",
          new Date().toISOString(),
        );
        db.run('UPDATE schedules SET enabled=0,next_run=NULL');
      }),
    );
    if (removeCredentials) this.vault.remove(dspId);
    this.audit.record(actorId, dspId, 'connection.disabled');
    return this.connection(dspId);
  }
}
