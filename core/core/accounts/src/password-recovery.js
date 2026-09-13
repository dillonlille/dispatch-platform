'use strict';

const crypto = require('node:crypto');
const { AccessError, exact, email, password } = require('./validation');
const { hashPassword } = require('./passwords');
const RESET_TTL_MS = 30 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Persist all buckets, including unknown emails, across processes/restarts.
// Never evict live buckets: reaching the storage bound fails closed.
function consumeRecoveryLimits(store, limits, now) {
  return store.transaction(() => {
    const db = store.db;
    db.prepare('DELETE FROM password_recovery_limits WHERE reset_at<=?').run(now);
    const entries = limits.map(({ key, ...limit }) => {
      const hash = digest(key);
      return { ...limit, hash, row: db.prepare('SELECT * FROM password_recovery_limits WHERE key_hash=?').get(hash) };
    });
    if (entries.some(({ row, count, cooldown = 0 }) => row && (row.count >= count || now - row.last_at < cooldown))) return false;
    const size = db.prepare('SELECT count(*) AS size FROM password_recovery_limits').get().size;
    if (size + entries.filter(entry => !entry.row).length > 10000) return false;
    for (const { hash, row, window } of entries) {
      db.prepare(`INSERT INTO password_recovery_limits VALUES(?,?,?,?)
        ON CONFLICT(key_hash) DO UPDATE SET count=excluded.count,last_at=excluded.last_at`)
        .run(hash, (row?.count || 0) + 1, row?.reset_at ?? now + window, now);
    }
    return true;
  });
}

// Internal return value is for the email worker only, never an HTTP response.
function requestPasswordReset(input) {
  exact(input, ['email']);
  const selectedEmail = email(input.email);
  const now = this.now();
  return this.store.transaction(() => {
    if (!consumeRecoveryLimits(this.store, [{ key: `email:${selectedEmail}`, count: 5,
      window: 60 * 60 * 1000, cooldown: 60 * 1000 }], now)) return null;
    this.store.db.prepare('DELETE FROM password_reset_tokens WHERE expires_at<=?').run(now);
    const user = this.store.userByEmail(selectedEmail);
    if (!user || user.status !== 'active') return null;
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.db.prepare('INSERT INTO password_reset_tokens VALUES(?,?,?,?,?,?)')
      .run(digest(token), user.id, user.auth_version, user.email, now + RESET_TTL_MS, now);
    this.audit({ action: 'account.password.reset.request', targetType: 'user', targetId: user.id });
    return { token, email: user.email, userId: user.id, expiresAt: new Date(now + RESET_TTL_MS).toISOString() };
  });
}

async function resetPassword(input) {
  exact(input, ['token', 'newPassword', 'confirmPassword']);
  const invalid = () => { throw new AccessError('password_reset_invalid', 400); };
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) invalid();
  const hash = digest(input.token);
  const read = () => this.store.db.prepare(`SELECT r.* FROM password_reset_tokens r JOIN users u ON u.id=r.user_id
    WHERE r.token_hash=? AND r.expires_at>? AND u.status='active'
      AND u.auth_version=r.auth_version AND u.email=r.email`).get(hash, this.now());
  const initial = read();
  if (!initial) invalid();
  password(input.newPassword);
  if (input.newPassword !== input.confirmPassword) throw new AccessError('password_confirmation_mismatch');
  const passwordHash = await hashPassword(input.newPassword);
  // Hashing yields. Recheck the token, expiry and account inside the write lock,
  // so competing resets, CLI recovery and password changes have just one winner.
  return this.store.transaction(() => {
    const current = read();
    if (!current || current.user_id !== initial.user_id || current.auth_version !== initial.auth_version) invalid();
    this.store.updatePassword(current.user_id, passwordHash, this.now());
    // The users trigger removes ALL reset tokens, including tokens from other requests.
    this.store.deleteUserSessions(current.user_id);
    this.audit({ action: 'account.password.reset.complete', targetType: 'user', targetId: current.user_id });
    return { email: current.email, userId: current.user_id };
  });
}

module.exports = { RESET_TTL_MS, consumeRecoveryLimits, requestPasswordReset, resetPassword };
