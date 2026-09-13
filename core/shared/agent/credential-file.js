'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { registrationToken } = require('./protocol');

function fail() { throw Object.assign(new Error('runtime_agent_unavailable'), { code: 'runtime_agent_unavailable' }); }

function privateDirectoryIdentity(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target) fail();
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== 0o700 || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function readPrivateRegistrationToken(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
      || path.basename(file) !== 'registration-token') fail();
  const parent = path.dirname(file);
  const before = privateDirectoryIdentity(parent);
  let handle;
  let info;
  let raw;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    info = fs.fstatSync(handle);
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1
        || info.dev !== before.dev || (info.mode & 0o7777) !== 0o600 || info.size !== 44) fail();
    raw = fs.readFileSync(handle, 'utf8');
  } catch { fail(); }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
  let afterFile;
  try { afterFile = fs.lstatSync(file); } catch { fail(); }
  const after = privateDirectoryIdentity(parent);
  if (afterFile.isSymbolicLink() || afterFile.dev !== info.dev || afterFile.ino !== info.ino
      || before.dev !== after.dev || before.ino !== after.ino || fs.realpathSync(file) !== file
      || raw.length !== 44 || !raw.endsWith('\n')) fail();
  return registrationToken(raw.slice(0, -1));
}

function registrationTokenFileProvider(file) {
  readPrivateRegistrationToken(file);
  return () => readPrivateRegistrationToken(file);
}

module.exports = { readPrivateRegistrationToken, registrationTokenFileProvider };
