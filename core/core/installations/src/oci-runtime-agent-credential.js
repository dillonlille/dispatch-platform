'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALLATION_IDENTIFIER_RE } = require('../../../shared/contracts/src/installation');
const { registrationToken } = require('../../../shared/agent/protocol');

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function fsync(target, directory = false) {
  const flags = fs.constants.O_RDONLY | (directory ? fs.constants.O_DIRECTORY : 0);
  const handle = fs.openSync(target, flags);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function createOciRuntimeAgentCredentialPort({ credentialRoot } = {}) {
  if (typeof credentialRoot !== 'string' || !path.isAbsolute(credentialRoot)
      || path.resolve(credentialRoot) !== credentialRoot || /[\0\r\n]/.test(credentialRoot)) fail();
  const root = fs.lstatSync(credentialRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.geteuid()
      || (root.mode & 0o7777) !== 0o700 || fs.realpathSync(credentialRoot) !== credentialRoot) fail();
  const identity = Object.freeze({ dev: root.dev, ino: root.ino });

  function checkedRoot() {
    const current = fs.lstatSync(credentialRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.geteuid()
        || (current.mode & 0o7777) !== 0o700 || fs.realpathSync(credentialRoot) !== credentialRoot
        || current.dev !== identity.dev || current.ino !== identity.ino) fail();
  }

  function file(runtimeKey) {
    if (typeof runtimeKey !== 'string' || runtimeKey === 'local' || !INSTALLATION_IDENTIFIER_RE.test(runtimeKey)) fail();
    return path.join(credentialRoot, `${runtimeKey}.token`);
  }

  function read(runtimeKey) {
    checkedRoot();
    const selected = file(runtimeKey);
    const info = fs.lstatSync(selected);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
        || info.dev !== identity.dev || (info.mode & 0o7777) !== 0o600
        || fs.realpathSync(selected) !== selected || info.size < 32 || info.size > 256) fail();
    const raw = fs.readFileSync(selected, 'utf8');
    if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n') || raw.includes('\r') || raw.includes('\0')) fail();
    return registrationToken(raw.slice(0, -1));
  }

  function issue(runtimeKey, { rotate = false } = {}) {
    if (typeof rotate !== 'boolean') fail();
    checkedRoot();
    const selected = file(runtimeKey);
    let token;
    let tokenChanged = false;
    try {
      token = read(runtimeKey);
      if (rotate) token = null;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      token = null;
    }
    if (token === null) {
      token = crypto.randomBytes(32).toString('base64url');
      const temporary = path.join(credentialRoot, `.${runtimeKey}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' });
        fsync(temporary);
        fs.renameSync(temporary, selected);
        fsync(credentialRoot, true);
      } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
      tokenChanged = true;
    }
    token = read(runtimeKey);
    return Object.freeze({
      runtimeKey,
      tokenHash: crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
      changed: tokenChanged,
      tokenChanged,
    });
  }

  function revoke(runtimeKey, expectedTokenHash = null) {
    if (expectedTokenHash !== null && !/^[a-f0-9]{64}$/.test(expectedTokenHash)) fail();
    const selected = file(runtimeKey);
    let token;
    try { token = read(runtimeKey); } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    const digest = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    if (expectedTokenHash !== null && digest !== expectedTokenHash) return false;
    fs.unlinkSync(selected);
    fsync(credentialRoot, true);
    return true;
  }

  return Object.freeze({ issue, revoke, read });
}

module.exports = { createOciRuntimeAgentCredentialPort };
