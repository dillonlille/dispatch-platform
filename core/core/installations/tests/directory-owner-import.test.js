'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test'), assert = require('node:assert/strict');
const { AccessStore } = require('../../accounts/src/store');
const { AccessControlService } = require('../../accounts/src/service');
const { administerOwner } = require('../../accounts/src/owner-admin');
const { importInitialOwner } = require('../../../host/controller/import-owner');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-import-'));
  const sourcePaths = { databaseRoot: path.join(root, 'source'), database: path.join(root, 'source/access-control.sqlite3') };
  const source = new AccessStore(sourcePaths);
  const target = new AccessStore({ databaseRoot: path.join(root, 'target'), database: path.join(root, 'target/access-control.sqlite3') });
  const credentials = { email: 'migration@example.test', password: 'synthetic import password' };
  await administerOwner(source, 'owner-create', { ...credentials, firstName: 'Migration', lastName: 'Fixture', confirmPassword: credentials.password });
  t.after(() => { source.close(); target.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, target, file: sourcePaths.database, credentials };
}

test('owner-only migration preserves login, leaves source unchanged and never reverts a later password on replay', async t => {
  const f = await fixture(t), sourceOwner = f.source.userByEmail(f.credentials.email);
  const before = JSON.stringify(sourceOwner);
  assert.equal(importInitialOwner(f.target, f.file).status, 'owner_imported');
  const access = new AccessControlService(f.target);
  const session = await access.signIn(f.credentials);
  assert.equal(session.session.user.platformRole, 'owner');
  assert.equal(f.target.db.prepare('SELECT count(*) n FROM memberships').get().n, 0);
  await administerOwner(f.target, 'owner-recover', { email: f.credentials.email, newEmail: '', password: 'new synthetic import password', confirmPassword: 'new synthetic import password' });
  assert.equal(importInitialOwner(f.target, f.file).status, 'owner_already_imported');
  await assert.rejects(access.signIn(f.credentials));
  assert.equal(JSON.stringify(f.source.userByEmail(f.credentials.email)), before);
});

test('owner import refuses a source with DSPs and rejects linked databases', async t => {
  const f = await fixture(t);
  const linked = path.join(f.root, 'linked.sqlite3'); fs.symlinkSync(f.file, linked);
  assert.throws(() => importInitialOwner(f.target, linked), { code: 'directory_import_unsafe' });
  f.source.db.prepare("INSERT INTO organizations VALUES('org_fixture','Synthetic','SYN','UTC','active',NULL,1,1)").run();
  assert.throws(() => importInitialOwner(f.target, f.file), { code: 'directory_import_mapping_required' });
  assert.equal(f.target.db.prepare('SELECT count(*) n FROM users').get().n, 0);
});
