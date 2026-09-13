'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccessStore } = require('../src/store');
const { createReleasePopup, loadPopup, validatePopup } = require('../src/release-popup');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-popup-'));
  const options = { databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/db.sqlite3') };
  let store = new AccessStore(options);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const user of ['platform', 'owner', 'other']) store.insertUser({ id: user, email: `${user}@example.test`,
    firstName: user, lastName: 'User', passwordHash: 'synthetic', platformRole: user === 'platform' ? 'owner' : null, timestamp: 1 });
  store.createOrganization({ id: 'org_one', name: 'One', abbreviation: null, timezone: 'UTC', status: 'active', createdBy: null, timestamp: 1 });
  store.createInstallation('org_one', 'runtime_one', 'ready', 1, 'dispatch_1.2.3', 'native_service_v1');
  const release = { schemaVersion: 1, releaseId: 'dispatch_1.2.3', version: '1.2.3', sourceCommit: 'a'.repeat(40),
    changelog: [
      { kind: 'added', title: 'Private platform change', description: 'Platform-only details', audience: 'platform' },
      { kind: 'fixed', title: 'DSP search', description: 'Relevant details', audience: 'dsp' },
    ], afterUpdating: [
      { title: 'Private action', description: 'Platform-only action', audience: 'platform' },
      { title: 'DSP action', description: 'Relevant action', audience: 'dsp' },
    ] };
  const platform = { user: { id: 'platform' }, platformPermissions: ['platform.organizations.read'], memberships: [] };
  const owner = { user: { id: 'owner' }, platformPermissions: [], activeOrganizationId: 'org_one',
    memberships: [{ organizationId: 'org_one', organization: { status: 'active' }, permissions: ['organization.owner'] }] };
  function rollout(value = release, status = 'completed') {
    store.db.prepare('INSERT INTO platform_rollouts VALUES(?,?,?,?,?,?,?)').run(value.releaseId, value.releaseId, 'platform', value.releaseId, status, 1, 1);
    store.db.prepare('INSERT INTO platform_rollout_core VALUES(?,?,?,?,?,?)').run(value.releaseId, 'succeeded',
      JSON.stringify({ ...value, publishedAt: '2026-09-07T00:00:00.000Z' }), 1, null, 1);
  }
  return { root, get store() { return store; }, release, platform, owner, rollout,
    service: (value = release) => createReleasePopup({ store, release: value }),
    reopen() { store.close(); store = new AccessStore(options); } };
}
test('only completed rollout of running release is announced; DSP must match verified installation', t => {
  const f = fixture(t), service = f.service();
  assert.equal(service.pending(f.platform).release, null);
  f.rollout(f.release, 'running');
  assert.equal(service.pending(f.platform).release, null);
  f.store.db.prepare("UPDATE platform_rollouts SET status='completed'").run();
  f.store.db.prepare("UPDATE platform_rollout_core SET status='verifying'").run();
  assert.equal(service.pending(f.platform).release, null);
  f.store.db.prepare("UPDATE platform_rollout_core SET status='succeeded'").run();
  assert.equal(service.pending(f.platform).release.version, '1.2.3');
  f.store.db.prepare("UPDATE installations SET release_id='dispatch_1.2.2'").run();
  assert.equal(service.pending(f.owner).release, null);
  f.store.db.prepare("UPDATE installations SET release_id='dispatch_1.2.3',status='verifying'").run();
  assert.equal(service.pending(f.owner).release, null);
  f.store.db.prepare("UPDATE installations SET status='ready'").run();
  assert.equal(service.pending(f.owner).release.version, '1.2.3');
});
test('DSP response contains no platform text, actions, audience tags or source metadata', t => {
  const f = fixture(t); f.rollout(); const service = f.service();
  assert.equal(service.pending(f.platform).release.changelog.length, 2);
  const result = service.pending(f.owner);
  assert.equal(result.release.changelog.length, 1);
  assert.equal(result.release.afterUpdating.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /Private|Platform-only|audience|sourceCommit/);
  assert.equal(service.pending({ ...f.owner, memberships: [] }).release, null);
  assert.equal(service.pending({ ...f.owner, memberships: [{ ...f.owner.memberships[0], permissions: ['dashboard.view'] }] }).release, null);
  assert.equal(service.pending({ ...f.platform, dspView: {} }).release, null);
  const platformOnly = { ...f.release, changelog: [f.release.changelog[0]] };
  assert.equal(f.service(platformOnly).pending(f.owner).release, null);
});
test('dismissal is idempotent, per user/release, survives database reopen; new version appears once', t => {
  const f = fixture(t); f.rollout();
  const service = f.service();
  service.dismiss(f.owner, { releaseId: f.release.releaseId });
  service.dismiss(f.owner, { releaseId: f.release.releaseId });
  assert.equal(service.pending(f.owner).release, null);
  assert.ok(service.pending(f.platform).release);
  assert.ok(service.pending({ ...f.owner, user: { id: 'other' } }).release);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM release_popup_dismissals').get().n, 1);
  f.reopen();
  assert.equal(f.service().pending(f.owner).release, null);
  const next = { ...f.release, releaseId: 'dispatch_1.2.4', version: '1.2.4' };
  f.rollout(next);
  f.store.db.prepare('UPDATE installations SET release_id=?').run(next.releaseId);
  assert.ok(f.service(next).pending(f.owner).release);
  f.service(next).dismiss(f.owner, { releaseId: next.releaseId });
  assert.equal(f.service(next).pending(f.owner).release, null);
  assert.throws(() => f.service(next).dismiss(f.owner, { releaseId: f.release.releaseId }), { code: 'release_popup_unavailable' });
  assert.throws(() => f.service().dismiss(f.platform, { releaseId: f.release.releaseId, userId: 'other' }));
});
test('legacy database receives additive dismissal table without changing existing users', t => {
  const f = fixture(t);
  f.store.db.exec('DROP TABLE release_popup_dismissals');
  f.reopen();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM users').get().n, 3);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM release_popup_dismissals').get().n, 0);
});
test('bundled copy must match deployed identity; missing, invalid and oversized copy stays quiet', t => {
  const f = fixture(t), file = path.join(f.root, 'popup.json');
  assert.equal(loadPopup(file, f.release), null);
  fs.writeFileSync(file, JSON.stringify(f.release));
  assert.deepEqual(loadPopup(file, f.release), f.release);
  assert.equal(loadPopup(file, { ...f.release, sourceCommit: 'b'.repeat(40) }), null);
  assert.throws(() => validatePopup({ ...f.release, changelog: [{ ...f.release.changelog[0], audience: 'all' }] }, f.release));
  fs.writeFileSync(file, ' '.repeat(128 * 1024 + 1));
  assert.equal(loadPopup(file, f.release), null);
});
