'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore } = require('../../accounts/src/store');
const { readPrivateRegistrationToken } = require('../../agents/src');

const command = path.resolve(__dirname, "../bin/dispatch-runtime-agent-authority");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-authority-cli-'));
  fs.chmodSync(root, 0o700);
  const accessRoot = path.join(root, 'access');
  const installationsRoot = path.join(root, 'installations');
  fs.mkdirSync(accessRoot, { mode: 0o700 });
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  const paths = { databaseRoot: accessRoot, database: path.join(accessRoot, 'access-control.sqlite3') };
  const store = new AccessStore(paths);
  store.transaction(() => {
    store.createOrganization({
      id: 'org_agent_cli', name: 'Agent CLI', abbreviation: 'ACL',
      timezone: 'America/Los_Angeles', status: 'pending_owner', createdBy: null, timestamp: 1_000,
    });
    store.insertStation('org_agent_cli', 'TST1', true, 1_000);
    store.createInstallation('org_agent_cli', 'runtime_agent_cli', 'provisioning', 1_000);
  });
  store.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { paths, accessRoot, installationsRoot };
}

function run(context, operation) {
  const result = spawnSync(command, [operation, 'org_agent_cli'], {
    env: {
      PATH: process.env.PATH,
      DISPATCH_ACCESS_CONTROL_DATABASE_ROOT: context.accessRoot,
      DISPATCH_INSTALLATIONS_ROOT: context.installationsRoot,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 0, result.stderr || output.status);
  assert.equal(output.ok, true);
  return output;
}

function authority(context) {
  const store = new AccessStore(context.paths);
  try { return store.runtimeAgentAuthority('runtime_agent_cli'); }
  finally { store.close(); }
}

function tokenFile(context) {
  return path.join(context.installationsRoot, 'runtime_agent_cli', 'secrets', 'runtime-agent', 'registration-token');
}

test('authority CLI issues, rotates, revokes, and explicitly reissues one generation-fenced token', t => {
  const context = fixture(t);
  assert.equal(run(context, 'issue').generation, 1);
  const firstToken = readPrivateRegistrationToken(tokenFile(context));
  assert.equal(authority(context).generation, 1);

  assert.equal(run(context, 'rotate').generation, 2);
  assert.notEqual(readPrivateRegistrationToken(tokenFile(context)), firstToken);
  assert.equal(authority(context).status, 'active');

  assert.equal(run(context, 'revoke').generation, 3);
  assert.equal(authority(context).status, 'revoked');
  assert.equal(fs.existsSync(tokenFile(context)), false);

  assert.equal(run(context, 'issue').generation, 4);
  const current = authority(context);
  assert.equal(current.status, 'active');
  assert.equal(current.token_hash,
    crypto.createHash('sha256').update(readPrivateRegistrationToken(tokenFile(context))).digest('hex'));
});
