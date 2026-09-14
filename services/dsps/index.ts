import type { Storage } from '../storage/index.js';
import type { Audit } from '../audit/index.js';
import { publicDsp, type Auth, type Context, type DspRow } from '../accounts/index.js';
import { id } from '../../shared/crypto.js';
import { assert } from '../../shared/errors.js';
import type {
  Connection,
  Dsp,
  DspSummary,
  Membership,
  Role,
} from '../../shared/contracts/index.js';
export class Dsps {
  constructor(
    readonly storage: Storage,
    readonly audit: Audit,
  ) {}
  create(name: string, timezone: string, actorId: string, permanent = false): Dsp {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    const dspId = id('dsp'),
      now = new Date().toISOString();
    this.storage.platform.run(
      "INSERT INTO dsps(id,name,environment,status,timezone,permanent,created_at) VALUES (?,?,?,'provisioning',?,?,?)",
      dspId,
      name,
      this.storage.config.standalone
        ? this.storage.config.environment
        : permanent
          ? 'preview'
          : 'production',
      timezone,
      Number(permanent),
      now,
    );
    this.initialize(dspId);
    this.audit.record(actorId, dspId, 'dsp.created');
    return this.get(dspId);
  }
  initialize(dspId: string) {
    const dsp = this.get(dspId);
    assert(['provisioning', 'failed'].includes(dsp.status), 'dsp_already_initialized', 409);
    try {
      for (const area of ['config', 'data', 'secrets', 'state'] as const)
        this.storage.paths.dspArea(dspId, area);
      this.storage.dsp(dspId, (db) =>
        db.transaction(() => {
          db.run(
            "INSERT OR IGNORE INTO connections(provider,updated_at) VALUES ('paycom',?)",
            new Date().toISOString(),
          );
          db.run(
            "INSERT OR IGNORE INTO schedules(provider,timezone) VALUES ('paycom',?)",
            dsp.timezone,
          );
        }),
      );
      this.storage.platform.run("UPDATE dsps SET status='active' WHERE id=?", dspId);
    } catch (error) {
      this.storage.platform.run("UPDATE dsps SET status='failed' WHERE id=?", dspId);
      throw error;
    }
  }
  get(id: string) {
    const row = this.storage.platform.one<DspRow>('SELECT * FROM dsps WHERE id=?', id);
    assert(row, 'dsp_not_found', 404);
    return publicDsp(row);
  }
  list(auth: Auth): DspSummary[] {
    const rows = auth.user.platformOwner
      ? this.storage.platform.all<DspRow>('SELECT * FROM dsps ORDER BY permanent DESC,name')
      : this.storage.platform.all<DspRow>(
          'SELECT d.* FROM dsps d JOIN memberships m ON m.dsp_id=d.id WHERE m.user_id=? ORDER BY d.permanent DESC,d.name',
          auth.user.id,
        );
    return rows.map((row) => {
      const dsp = publicDsp(row);
      const role = auth.user.platformOwner
        ? 'platform_owner'
        : this.storage.platform.one<{ role: Role }>(
            'SELECT role FROM memberships WHERE dsp_id=? AND user_id=?',
            dsp.id,
            auth.user.id,
          )!.role;
      let paycom: Connection['status'] = 'not_connected',
        lastCollection: string | null = null;
      if (['active', 'suspended'].includes(dsp.status))
        this.storage.dsp(dsp.id, (db) => {
          paycom =
            db.one<{ status: Connection['status'] }>(
              "SELECT status FROM connections WHERE provider='paycom'",
            )?.status ?? 'not_connected';
          lastCollection =
            db.one<{ at: string }>('SELECT collected_at at FROM publications WHERE active=1')?.at ??
            null;
        });
      return { ...dsp, role, paycom, lastCollection };
    });
  }
  setStatus(dspId: string, status: 'active' | 'suspended', actorId: string) {
    const dsp = this.get(dspId);
    assert(!dsp.permanent, 'permanent_dev_required', 409);
    assert(['active', 'suspended'].includes(dsp.status), 'dsp_unavailable', 409);
    this.storage.platform.run(
      'UPDATE dsps SET status=?,revision=revision+1 WHERE id=?',
      status,
      dspId,
    );
    this.audit.record(actorId, dspId, status === 'active' ? 'dsp.resumed' : 'dsp.suspended');
    return this.get(dspId);
  }
  update(context: Context, name: string, timezone: string) {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    this.storage.platform.run(
      'UPDATE dsps SET name=?,timezone=?,revision=revision+1 WHERE id=?',
      name,
      timezone,
      context.dsp.id,
    );
    this.storage.dsp(context.dsp.id, (db) =>
      db.run('UPDATE schedules SET timezone=?,next_run=NULL', timezone),
    );
    this.audit.record(context.user.id, context.dsp.id, 'dsp.settings_updated');
    return this.get(context.dsp.id);
  }
  members(dspId: string) {
    return this.storage.platform.all<Membership>(
      "SELECT m.id,m.user_id userId,m.dsp_id dspId,u.email,u.first_name || ' ' || u.last_name name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.dsp_id=? ORDER BY u.first_name,u.last_name",
      dspId,
    );
  }
  setRole(context: Context, memberId: string, role: Role | null) {
    this.storage.platform.transaction(() => {
      const membership = this.storage.platform.one<{ user_id: string; role: Role }>(
        'SELECT * FROM memberships WHERE id=? AND dsp_id=?',
        memberId,
        context.dsp.id,
      );
      assert(membership, 'member_not_found', 404);
      if (membership.role === 'owner' && role !== 'owner')
        assert(
          this.storage.platform.one<{ count: number }>(
            "SELECT count(*) count FROM memberships WHERE dsp_id=? AND role='owner'",
            context.dsp.id,
          )!.count > 1,
          'last_owner_required',
          409,
        );
      if (role)
        this.storage.platform.run('UPDATE memberships SET role=? WHERE id=?', role, memberId);
      else this.storage.platform.run('DELETE FROM memberships WHERE id=?', memberId);
      this.storage.platform.run('UPDATE dsps SET revision=revision+1 WHERE id=?', context.dsp.id);
      this.audit.record(
        context.user.id,
        context.dsp.id,
        role ? 'member.role_changed' : 'member.removed',
        role ?? '',
      );
    });
  }
}
