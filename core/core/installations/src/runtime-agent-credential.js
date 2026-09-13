'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALLATION_IDENTIFIER_RE } = require('../../../shared/contracts/src');
const { PROJECT_ROOT } = require('../../../shared/paths/runtime-paths');
const { registrationToken, readPrivateRegistrationToken } = require('../../agents/src');

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function directoryIdentity(target, expectedDevice = null) {
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
      || expectedDevice !== null && info.dev !== expectedDevice || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function syncDirectory(target) {
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(handle);
  } catch { fail(); }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
}

function ensureDirectory(target, parent, expectedDevice) {
  const parentBefore = directoryIdentity(parent, expectedDevice);
  let changed = false;
  try {
    fs.mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
    syncDirectory(parent);
    changed = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') fail();
  }
  directoryIdentity(target, parentBefore.dev);
  const parentAfter = directoryIdentity(parent, expectedDevice);
  if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) fail();
  return changed;
}

function writeToken(file, token, parentDevice) {
  const temporary = path.join(path.dirname(file), `.registration-token.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${registrationToken(token)}\n`, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    const handle = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    const info = fs.lstatSync(temporary);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
        || info.dev !== parentDevice || (info.mode & 0o7777) !== PRIVATE_FILE_MODE) fail();
    fs.renameSync(temporary, file);
    fs.chmodSync(file, PRIVATE_FILE_MODE);
    syncDirectory(path.dirname(file));
    return readPrivateRegistrationToken(file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function removeOrphanTokens(agentRoot, expectedDevice) {
  let changed = false;
  for (const name of fs.readdirSync(agentRoot)) {
    if (name === 'registration-token') continue;
    if (!/^\.registration-token\.[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(name)) fail();
    const target = path.join(agentRoot, name);
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
        || info.dev !== expectedDevice || (info.mode & 0o7777) !== PRIVATE_FILE_MODE
        || fs.realpathSync(target) !== target) fail();
    fs.unlinkSync(target);
    changed = true;
  }
  if (changed) syncDirectory(agentRoot);
  return changed;
}

function createRuntimeAgentCredentialManager({ installationsRoot } = {}) {
  if (typeof installationsRoot !== 'string' || !path.isAbsolute(installationsRoot)
      || path.resolve(installationsRoot) !== installationsRoot || contains(PROJECT_ROOT, installationsRoot)
      || contains(installationsRoot, PROJECT_ROOT)) fail();
  const rootIdentity = directoryIdentity(installationsRoot);

  function paths(runtimeKey) {
    if (typeof runtimeKey !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(runtimeKey) || runtimeKey === 'local') fail();
    const installationRoot = path.join(installationsRoot, runtimeKey);
    if (path.dirname(installationRoot) !== installationsRoot) fail();
    const secretsRoot = path.join(installationRoot, 'secrets');
    const agentRoot = path.join(secretsRoot, 'runtime-agent');
    return Object.freeze({
      installationRoot,
      secretsRoot,
      agentRoot,
      tokenFile: path.join(agentRoot, 'registration-token'),
    });
  }

  function assertRoot() {
    const current = directoryIdentity(installationsRoot);
    if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) fail();
  }

  function issue(runtimeKey, { rotate = false } = {}) {
    if (typeof rotate !== 'boolean') fail();
    assertRoot();
    const selected = paths(runtimeKey);
    let changed = ensureDirectory(selected.installationRoot, installationsRoot, rootIdentity.dev);
    const installationIdentity = directoryIdentity(selected.installationRoot, rootIdentity.dev);
    changed = ensureDirectory(selected.secretsRoot, selected.installationRoot, installationIdentity.dev) || changed;
    changed = ensureDirectory(selected.agentRoot, selected.secretsRoot, installationIdentity.dev) || changed;
    const agentIdentity = directoryIdentity(selected.agentRoot, installationIdentity.dev);
    changed = removeOrphanTokens(selected.agentRoot, agentIdentity.dev) || changed;
    let token;
    let tokenChanged = false;
    if (!rotate && fs.existsSync(selected.tokenFile)) token = readPrivateRegistrationToken(selected.tokenFile);
    else {
      token = writeToken(selected.tokenFile, crypto.randomBytes(32).toString('base64url'), agentIdentity.dev);
      changed = true;
      tokenChanged = true;
    }
    assertRoot();
    return Object.freeze({
      runtimeKey,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      changed,
      tokenChanged,
    });
  }

  function revoke(runtimeKey, expectedTokenHash = null) {
    if (expectedTokenHash !== null && !/^[a-f0-9]{64}$/.test(expectedTokenHash)) fail();
    assertRoot();
    const selected = paths(runtimeKey);
    if (!fs.existsSync(selected.agentRoot)) return false;
    const installationIdentity = directoryIdentity(selected.installationRoot, rootIdentity.dev);
    directoryIdentity(selected.secretsRoot, installationIdentity.dev);
    const agentIdentity = directoryIdentity(selected.agentRoot, installationIdentity.dev);
    const changed = removeOrphanTokens(selected.agentRoot, agentIdentity.dev);
    if (!fs.existsSync(selected.tokenFile)) return changed;
    const token = readPrivateRegistrationToken(selected.tokenFile);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    if (expectedTokenHash !== null && tokenHash !== expectedTokenHash) return changed;
    fs.unlinkSync(selected.tokenFile);
    syncDirectory(selected.agentRoot);
    return true;
  }

  return Object.freeze({ issue, revoke, paths });
}

module.exports = { createRuntimeAgentCredentialManager };
