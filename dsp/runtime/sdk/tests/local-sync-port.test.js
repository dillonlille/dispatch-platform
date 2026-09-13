'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { success } = require('dispatch-protocol/contracts/src');
const { AuthenticatedSyncPort } = require('../../application/sync/authenticated-sync-port');
const { LocalSyncManagerPort } = require('dispatch-runtime-kit/adapters/local/sync-manager-port');

function fixture({ configured = true, authProfile = 'paycom-main', profileProvider = 'paycom', session = 'not_started' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-local-sync-'));
  const database = path.join(root, 'collection.sqlite3');
  fs.writeFileSync(database, 'fixture', { mode: 0o600 });
  const events = [];
  const storeFactory = () => ({
    sync: () => ({ id: 'paycom-main-workforce', source: 'paycom-main' }),
    source: () => ({ id: 'paycom-main', collector: 'paycom', authProfile }),
    close: () => events.push('store.close'),
  });
  const serviceFactory = () => ({
    start: () => { events.push('sync.start'); return { sync: {}, run: {} }; },
    stop: async () => { events.push('sync.stop'); return {}; },
    restart: async () => { events.push('sync.restart'); return { sync: {}, run: {} }; },
    runNow: () => { events.push('sync.run'); return { sync: {}, run: {} }; },
    edit: async () => { events.push('sync.edit'); return { sync: {}, run: null }; },
  });
  const manager = new LocalSyncManagerPort({ paths: { database }, storeFactory, serviceFactory });
  const authService = { start: async () => { events.push('auth.start'); return { status: 'ready' }; } };
  const auth = {
    profileStatus: async profile => {
      events.push(`auth.status:${profile}`);
      return success(configured ? 'configured' : 'not_configured', configured
        ? {
          profile: {
            configured: true, profile, provider: profileProvider,
            createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
          },
          session,
        }
        : { profile: { configured: false, profile }, session });
    },
  };
  return {
    root, events, manager,
    port: new AuthenticatedSyncPort({ sync: manager, auth, authService }),
  };
}

function cleanup(value) { fs.rmSync(value.root, { recursive: true, force: true }); }

test('application sync coordination ensures Auth before authenticated mutations', async () => {
  const value = fixture();
  try {
    await value.port.start('paycom-main-workforce');
    await value.port.restart('paycom-main-workforce', {});
    await value.port.runNow('paycom-main-workforce');
    await value.port.edit('paycom-main-workforce', { settings: { mode: 'publish' } }, { applyNow: true });
    assert.deepEqual(value.events.filter(event => event !== 'store.close'), [
      'auth.start', 'auth.status:paycom-main', 'sync.start',
      'auth.start', 'auth.status:paycom-main', 'sync.restart',
      'auth.start', 'auth.status:paycom-main', 'sync.run',
      'auth.start', 'auth.status:paycom-main', 'sync.edit',
    ]);
  } finally { cleanup(value); }
});

test('recoverable manual session state can queue a tick while an operator lock cannot', async () => {
  const recovering = fixture({ session: 'manual_verification_required' });
  try {
    await recovering.port.start('paycom-main-workforce');
    assert.equal(recovering.events.includes('sync.start'), true);
  } finally { cleanup(recovering); }

  const locked = fixture({ session: 'locked' });
  try {
    await assert.rejects(locked.port.start('paycom-main-workforce'), error => error.code === 'profile_locked');
    assert.equal(locked.events.includes('sync.start'), false);
  } finally { cleanup(locked); }
});

test('application sync coordination fails before state mutation for missing or mismatched profiles', async () => {
  const missing = fixture({ configured: false });
  try {
    await assert.rejects(missing.port.start('paycom-main-workforce'), error => error.code === 'profile_not_configured');
    assert.equal(missing.events.includes('sync.start'), false);
  } finally { cleanup(missing); }

  const mismatched = fixture({ profileProvider: 'other' });
  try {
    await assert.rejects(mismatched.port.start('paycom-main-workforce'), error => error.code === 'profile_provider_mismatch');
    assert.equal(mismatched.events.includes('sync.start'), false);
  } finally { cleanup(mismatched); }
});

test('sync without an Auth profile starts without touching the broker', async () => {
  const value = fixture({ authProfile: null });
  try {
    await value.port.start('paycom-main-workforce');
    assert.deepEqual(value.events.filter(event => event !== 'store.close'), ['sync.start']);
  } finally { cleanup(value); }
});

test('local sync manager port exposes only a sanitized authentication requirement', () => {
  const value = fixture();
  try {
    assert.deepEqual(value.manager.authentication('paycom-main-workforce'), {
      required: true, profile: 'paycom-main', provider: 'paycom',
    });
  } finally { cleanup(value); }
});
