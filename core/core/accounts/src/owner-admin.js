'use strict';

// Server-local capability. Deliberately not part of the HTTP service or SDK.
const crypto = require('node:crypto');
const { AccessError, exact, email, text, password } = require('./validation');
const { hashPassword } = require('./passwords');

function listOwners(store) {
  return store.db.prepare(`SELECT id,email,first_name AS firstName,last_name AS lastName,status
    FROM users WHERE platform_role='owner' ORDER BY created_at,id`).all();
}

async function administerOwner(store, action, input, now = Date.now) {
  if (!['owner-create', 'owner-recover'].includes(action)) throw new AccessError('invalid_input');
  exact(input, action === 'owner-create'
    ? ['email', 'firstName', 'lastName', 'password', 'confirmPassword']
    : ['email', 'newEmail', 'password', 'confirmPassword']);
  const selectedEmail = email(input.email);
  const newEmail = action === 'owner-recover' && input.newEmail ? email(input.newEmail) : selectedEmail;
  password(input.password);
  if (input.password !== input.confirmPassword) throw new AccessError('password_confirmation_mismatch');
  const firstName = action === 'owner-create' ? text(input.firstName, 'firstName', { maximum: 80 }) : null;
  const lastName = action === 'owner-create' ? text(input.lastName, 'lastName', { maximum: 80 }) : null;
  const previous = store.userByEmail(selectedEmail);
  if (action === 'owner-recover' && previous?.platform_role !== 'owner') throw new AccessError('platform_owner_not_found', 404);
  const passwordHash = await hashPassword(input.password);
  return store.transaction(() => {
    const timestamp = now();
    let userId;
    if (action === 'owner-create') {
      if (listOwners(store).length) throw new AccessError('platform_owner_exists', 409);
      if (store.userByEmail(selectedEmail)) throw new AccessError('email_in_use', 409);
      userId = `usr_${crypto.randomUUID().replaceAll('-', '')}`;
      store.insertUser({ id: userId, email: selectedEmail, firstName, lastName, passwordHash, platformRole: 'owner', timestamp });
      // An earlier bootstrap link must not remain able to create another owner.
      store.db.prepare("UPDATE invitations SET status='revoked' WHERE kind='platform_owner' AND status='pending'").run();
    } else {
      const current = store.userById(previous.id);
      if (current?.platform_role !== 'owner' || current.email !== selectedEmail || current.auth_version !== previous.auth_version) {
        throw new AccessError('account_changed', 409);
      }
      const conflict = store.userByEmail(newEmail);
      if (conflict && conflict.id !== current.id) throw new AccessError('email_in_use', 409);
      userId = current.id;
      store.db.prepare(`UPDATE users SET email=?,password_hash=?,status='active',auth_version=auth_version+1,updated_at=? WHERE id=?`)
        .run(newEmail, passwordHash, timestamp, userId);
      store.deleteUserSessions(userId);
      store.db.prepare("UPDATE invitations SET status='revoked' WHERE status='pending' AND email IN (?,?)")
        .run(selectedEmail, newEmail);
    }
    store.createAudit({ id: `aud_${crypto.randomUUID().replaceAll('-', '')}`, actorUserId: null, organizationId: null,
      action: action === 'owner-create' ? 'platform.owner.create_cli' : 'platform.owner.recover_cli',
      targetType: 'user', targetId: userId, result: 'succeeded', timestamp });
    return { status: action === 'owner-create' ? 'platform_owner_created' : 'platform_owner_recovered' };
  });
}

module.exports = { administerOwner, listOwners };
