'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOciRuntimeAgentCredentialPort } = require('../src/oci-runtime-agent-credential');

test('OCI Runtime Agent credentials remain in the central private handoff root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-oci-agent-credential-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = createOciRuntimeAgentCredentialPort({ credentialRoot: root });
  const first = port.issue('runtime_oci_credential');
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(first.tokenChanged, true);
  assert.equal(port.issue('runtime_oci_credential').tokenHash, first.tokenHash);
  const file = path.join(root, 'runtime_oci_credential.token');
  assert.equal(fs.lstatSync(file).mode & 0o7777, 0o600);
  assert.equal(port.read('runtime_oci_credential').includes('\n'), false);
  const rotated = port.issue('runtime_oci_credential', { rotate: true });
  assert.notEqual(rotated.tokenHash, first.tokenHash);
  assert.equal(port.revoke('runtime_oci_credential', first.tokenHash), false);
  assert.equal(port.revoke('runtime_oci_credential', rotated.tokenHash), true);
  assert.equal(port.revoke('runtime_oci_credential', rotated.tokenHash), false);
});
