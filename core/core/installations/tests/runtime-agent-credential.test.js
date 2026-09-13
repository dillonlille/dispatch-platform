'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createRuntimeAgentCredentialManager,
  createInstallationLayoutManager,
  INSTALLATION_LAYOUT_TEMPLATE,
} = require('../src');
const { readPrivateRegistrationToken } = require('../../agents/src');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-credential-'));
  fs.chmodSync(root, 0o700);
  const installationsRoot = path.join(root, 'installations');
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return installationsRoot;
}

function manifest() {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_agent_credential', stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: 'runtime_agent_credential', templateId: INSTALLATION_LAYOUT_TEMPLATE, releaseId: 'dispatch_fixture_1' },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

test('runtime-agent credential materialization is private, stable, rotatable, and layout-compatible', t => {
  const installationsRoot = fixture(t);
  const credentials = createRuntimeAgentCredentialManager({ installationsRoot });
  const first = credentials.issue('runtime_agent_credential');
  assert.equal(first.changed, true);
  assert.equal(first.tokenChanged, true);
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(first, 'token'), false);
  const tokenFile = credentials.paths('runtime_agent_credential').tokenFile;
  const firstToken = readPrivateRegistrationToken(tokenFile);
  assert.equal(fs.lstatSync(tokenFile).mode & 0o7777, 0o600);
  const orphan = path.join(path.dirname(tokenFile), `.registration-token.${process.pid}.0123456789abcdef.tmp`);
  fs.writeFileSync(orphan, `${firstToken}\n`, { mode: 0o600 });
  const replayed = credentials.issue('runtime_agent_credential');
  assert.equal(replayed.tokenHash, first.tokenHash);
  assert.equal(replayed.tokenChanged, false);
  assert.equal(fs.existsSync(orphan), false);

  const selectedManifest = manifest();
  const layout = createInstallationLayoutManager({ installationsRoot });
  assert.equal(layout.materialize(selectedManifest, authority(selectedManifest)).status, 'verified');
  assert.equal(readPrivateRegistrationToken(tokenFile), firstToken);

  const rotated = credentials.issue('runtime_agent_credential', { rotate: true });
  assert.equal(rotated.tokenChanged, true);
  assert.notEqual(rotated.tokenHash, first.tokenHash);
  assert.notEqual(readPrivateRegistrationToken(tokenFile), firstToken);
  assert.equal(credentials.revoke('runtime_agent_credential', first.tokenHash), false);
  assert.equal(fs.existsSync(tokenFile), true);
  assert.equal(credentials.revoke('runtime_agent_credential', rotated.tokenHash), true);
  assert.equal(credentials.revoke('runtime_agent_credential'), false);
  assert.equal(fs.existsSync(tokenFile), false);
});
