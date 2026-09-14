import type { Storage } from '../storage/index.js';
import type { Audit } from '../audit/index.js';
import { AppError, assert } from '../../shared/errors.js';
import {
  checkPassword,
  equal,
  hashPassword,
  id,
  sha256,
  sign,
  token,
} from '../../shared/crypto.js';
import type { Dsp, Permission, Role, User } from '../../shared/contracts/index.js';
export interface Auth {
  user: User;
  hash: string;
  csrf: string;
}
export interface Context extends Auth {
  dsp: Dsp;
  role: Role | 'platform_owner';
}
export interface UserRow {
  id: string;
  email: string;
  name: string;
  password: string;
  platform_owner: number;
  status: string;
  version: number;
}
export interface DspRow {
  id: string;
  name: string;
  environment: 'production' | 'preview';
  status: Dsp['status'];
  timezone: string;
  permanent: number;
  revision: number;
  created_at: string;
}
export const publicDsp = (r: DspRow): Dsp => ({
  id: r.id,
  name: r.name,
  environment: r.environment,
  status: r.status,
  timezone: r.timezone,
  permanent: Boolean(r.permanent),
  revision: r.revision,
  createdAt: r.created_at,
});
const publicUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  platformOwner: Boolean(r.platform_owner),
});
const roles: Record<Role | 'platform_owner', readonly Permission[]> = {
  platform_owner: ['read', 'collect', 'connections', 'settings', 'members'],
  owner: ['read', 'collect', 'connections', 'settings', 'members'],
  manager: ['read', 'collect'],
  member: ['read'],
};
export class Accounts {
  private dummy = hashPassword('a-long-dummy-password-for-timing');
  constructor(
    readonly storage: Storage,
    readonly audit: Audit,
  ) {}
  async createUser(
    email: string,
    name: string,
    password: string,
    platformOwner = false,
  ): Promise<User> {
    const encoded = await hashPassword(password),
      userId = id('usr');
    this.storage.platform.run(
      'INSERT INTO users(id,email,name,password,platform_owner,created_at) VALUES (?,?,?,?,?,?)',
      userId,
      email.trim().toLowerCase(),
      name.trim(),
      encoded,
      Number(platformOwner),
      new Date().toISOString(),
    );
    return { id: userId, email: email.trim().toLowerCase(), name: name.trim(), platformOwner };
  }
  throttle(key: string, maximum: number, windowMs: number) {
    const db = this.storage.platform,
      now = Date.now(),
      hashed = sha256(key);
    db.transaction(() => {
      db.run('DELETE FROM throttle WHERE reset_at<?', now);
      const row = db.one<{ count: number }>('SELECT count FROM throttle WHERE key=?', hashed);
      assert((row?.count ?? 0) < maximum, 'rate_limited', 429);
      assert(
        row || db.one<{ count: number }>('SELECT count(*) count FROM throttle')!.count < 10000,
        'rate_limited',
        429,
      );
      db.run(
        'INSERT INTO throttle(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
        hashed,
        now + windowMs,
      );
    });
  }
  async login(email: string, password: string, ip: string) {
    this.throttle(`login:ip:${ip}`, 30, 15 * 60_000);
    this.throttle(`login:email:${email.toLowerCase()}`, 10, 15 * 60_000);
    const row = this.storage.platform.one<UserRow>(
      'SELECT * FROM users WHERE email=?',
      email.trim().toLowerCase(),
    );
    const valid = await checkPassword(password, row?.password ?? (await this.dummy));
    assert(row && valid && row.status === 'active', 'invalid_login', 401);
    const raw = token(),
      hash = sha256(raw),
      now = Date.now();
    this.storage.platform.transaction(() => {
      const fresh = this.storage.platform.one<UserRow>('SELECT * FROM users WHERE id=?', row.id);
      assert(fresh?.status === 'active' && fresh.version === row.version, 'invalid_login', 401);
      this.storage.platform.run('DELETE FROM sessions WHERE expires_at<?', now);
      this.storage.platform.run(
        'INSERT INTO sessions(hash,user_id,user_version,expires_at,created_at) VALUES (?,?,?,?,?)',
        hash,
        row.id,
        row.version,
        now + 8 * 60 * 60_000,
        now,
      );
      this.audit.record(row.id, null, 'account.signed_in');
    });
    return { raw, auth: this.authenticate(raw) };
  }
  authenticate(raw?: string): Auth {
    assert(raw && /^[A-Za-z0-9_-]{43}$/.test(raw), 'sign_in_required', 401);
    const hash = sha256(raw);
    const row = this.storage.platform.one<UserRow>(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires_at>? AND s.user_version=u.version AND u.status='active'",
      hash,
      Date.now(),
    );
    assert(row, 'sign_in_required', 401);
    return { user: publicUser(row), hash, csrf: sign(this.storage.key, `csrf:${raw}`) };
  }
  checkCsrf(auth: Auth, value: unknown) {
    assert(typeof value === 'string' && equal(auth.csrf, value), 'csrf_required', 403);
  }
  logout(auth: Auth) {
    this.storage.platform.run('DELETE FROM sessions WHERE hash=?', auth.hash);
  }
  platform(auth: Auth) {
    assert(auth.user.platformOwner, 'platform_owner_required', 403);
  }
  context(auth: Auth, dspId: string, permission: Permission = 'read'): Context {
    const dsp = this.storage.platform.one<DspRow>('SELECT * FROM dsps WHERE id=?', dspId);
    assert(dsp, 'dsp_unavailable', 404);
    const membership = this.storage.platform.one<{ role: Role }>(
      'SELECT role FROM memberships WHERE user_id=? AND dsp_id=?',
      auth.user.id,
      dspId,
    );
    const role = auth.user.platformOwner ? 'platform_owner' : membership?.role;
    assert(role && roles[role].includes(permission), 'permission_denied', 403);
    assert(dsp.status === 'active', 'dsp_unavailable', 409);
    return { ...auth, dsp: publicDsp(dsp), role };
  }
  view(auth: Auth, dspId: string) {
    const context = this.context(auth, dspId);
    this.audit.record(
      auth.user.id,
      dspId,
      auth.user.platformOwner ? 'dsp.owner_view_opened' : 'dsp.view_opened',
    );
    return { dsp: context.dsp, role: context.role, token: this.viewToken(context) };
  }
  viewToken(context: Context) {
    return `${context.dsp.id}.${sign(this.storage.key, `view:${context.hash}:${context.dsp.id}:${context.dsp.revision}:${context.role}`)}`;
  }
  fromView(auth: Auth, value: unknown, permission: Permission = 'read') {
    assert(typeof value === 'string' && value.length < 200, 'dsp_view_required', 403);
    const context = this.context(auth, value.split('.')[0]!, permission);
    assert(equal(this.viewToken(context), value), 'dsp_view_expired', 409);
    return context;
  }
  revalidate(context: Context, permission: Permission = 'read') {
    const live = this.storage.platform.one<UserRow>(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires_at>? AND s.user_version=u.version AND u.status='active'",
      context.hash,
      Date.now(),
    );
    assert(live, 'sign_in_required', 401);
    const fresh = this.context({ ...context, user: publicUser(live) }, context.dsp.id, permission);
    assert(
      fresh.dsp.revision === context.dsp.revision && fresh.role === context.role,
      'dsp_view_expired',
      409,
    );
    return fresh;
  }
  async changePassword(auth: Auth, current: string, replacement: string) {
    const row = this.storage.platform.one<UserRow>('SELECT * FROM users WHERE id=?', auth.user.id)!;
    assert(await checkPassword(current, row.password), 'invalid_password', 403);
    const encoded = await hashPassword(replacement);
    this.storage.platform.transaction(() => {
      assert(
        this.storage.platform.one<UserRow>('SELECT * FROM users WHERE id=?', row.id)?.version ===
          row.version,
        'account_changed',
        409,
      );
      this.storage.platform.run(
        'UPDATE users SET password=?,version=version+1 WHERE id=?',
        encoded,
        row.id,
      );
      this.storage.platform.run('DELETE FROM sessions WHERE user_id=?', row.id);
      this.storage.platform.run('DELETE FROM resets WHERE user_id=?', row.id);
      this.audit.record(row.id, null, 'account.password_changed');
    });
  }
  invite(auth: Auth, dspId: string, email: string, role: Role) {
    this.context(auth, dspId, 'members');
    const raw = token();
    this.storage.platform.run(
      'INSERT INTO invitations(hash,dsp_id,email,role,expires_at,created_by) VALUES (?,?,?,?,?,?)',
      sha256(raw),
      dspId,
      email.trim().toLowerCase(),
      role,
      Date.now() + 7 * 86400_000,
      auth.user.id,
    );
    this.audit.record(auth.user.id, dspId, 'member.invited', role);
    return raw;
  }
  invitation(raw: string) {
    const row = this.storage.platform.one<{
      email: string;
      dspId: string;
      dspName: string;
      role: Role;
    }>(
      "SELECT i.email,i.dsp_id dspId,d.name dspName,i.role FROM invitations i JOIN dsps d ON d.id=i.dsp_id WHERE i.hash=? AND i.used_at IS NULL AND i.expires_at>? AND d.status='active'",
      sha256(raw),
      Date.now(),
    );
    assert(row, 'invitation_expired', 404);
    return row;
  }
  async acceptInvitation(raw: string, name: string, password: string) {
    const invite = this.invitation(raw);
    const existing = this.storage.platform.one<UserRow>(
      'SELECT * FROM users WHERE email=?',
      invite.email,
    );
    if (existing)
      assert(
        existing.status === 'active' && (await checkPassword(password, existing.password)),
        'sign_in_with_existing_password',
        403,
      );
    const encoded = existing?.password ?? (await hashPassword(password)),
      userId = existing?.id ?? id('usr');
    this.storage.platform.transaction(() => {
      this.invitation(raw);
      if (existing) {
        const fresh = this.storage.platform.one<UserRow>(
          'SELECT * FROM users WHERE id=?',
          existing.id,
        );
        assert(
          fresh?.status === 'active' && fresh.version === existing.version,
          'account_changed',
          409,
        );
      } else
        this.storage.platform.run(
          'INSERT INTO users(id,email,name,password,created_at) VALUES (?,?,?,?,?)',
          userId,
          invite.email,
          name,
          encoded,
          new Date().toISOString(),
        );
      this.storage.platform.run(
        'INSERT INTO memberships(id,user_id,dsp_id,role) VALUES (?,?,?,?) ON CONFLICT(user_id,dsp_id) DO NOTHING',
        id('mem'),
        userId,
        invite.dspId,
        invite.role,
      );
      this.storage.platform.run(
        'UPDATE invitations SET used_at=? WHERE hash=?',
        Date.now(),
        sha256(raw),
      );
      this.audit.record(userId, invite.dspId, 'member.joined');
    });
  }
  recoveryToken(email: string) {
    const user = this.storage.platform.one<UserRow>(
      "SELECT * FROM users WHERE email=? AND status='active'",
      email.trim().toLowerCase(),
    );
    if (!user) return null;
    const raw = token();
    this.storage.platform.transaction(() => {
      this.storage.platform.run(
        'DELETE FROM resets WHERE user_id=? OR expires_at<?',
        user.id,
        Date.now(),
      );
      this.storage.platform.run(
        'INSERT INTO resets(hash,user_id,user_version,expires_at) VALUES (?,?,?,?)',
        sha256(raw),
        user.id,
        user.version,
        Date.now() + 30 * 60_000,
      );
    });
    return { raw, email: user.email };
  }
  async resetPassword(raw: string, password: string) {
    const encoded = await hashPassword(password),
      db = this.storage.platform;
    db.transaction(() => {
      const row = db.one<{ user_id: string }>(
        "SELECT r.user_id FROM resets r JOIN users u ON u.id=r.user_id WHERE r.hash=? AND r.used_at IS NULL AND r.expires_at>? AND r.user_version=u.version AND u.status='active'",
        sha256(raw),
        Date.now(),
      );
      assert(row, 'reset_expired', 400);
      db.run('UPDATE users SET password=?,version=version+1 WHERE id=?', encoded, row.user_id);
      db.run('DELETE FROM resets WHERE user_id=?', row.user_id);
      db.run('DELETE FROM sessions WHERE user_id=?', row.user_id);
      this.audit.record(row.user_id, null, 'account.password_reset');
    });
  }
}
