'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseStrictJson } = require('dispatch-runtime-kit/auth-broker/src/strict-json');
const { trustedCommandPath } = require('dispatch-protocol/trusted-command-path');

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const OWNER_HOME = os.homedir();

function fail(code) { throw Object.assign(new Error(code), { code }); }

function safeExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) fail('unsafe_executable');
  if (!file.startsWith(`${PROJECT_ROOT}${path.sep}`)) fail('unsafe_executable');
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    let directory;
    try { directory = fs.lstatSync(current); } catch { fail('unsafe_executable'); }
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.geteuid()
        || (directory.mode & 0o022) !== 0 || fs.realpathSync(current) !== current) fail('unsafe_executable');
    if (current === PROJECT_ROOT) break;
    if (current === path.dirname(current) || !current.startsWith(`${PROJECT_ROOT}${path.sep}`)) fail('unsafe_executable');
  }
  let info;
  try { info = fs.lstatSync(file); } catch { fail('helper_unavailable'); }
  const mode = info.mode & 0o7777;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || (mode & 0o022) !== 0 || (mode & 0o100) === 0 || fs.realpathSync(file) !== file) fail('unsafe_executable');
  return file;
}

function fixedEnvironment() {
  return Object.freeze({
    HOME: OWNER_HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: trustedCommandPath(),
  });
}

function helperEnvironment(environment = {}) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
      || Object.getPrototypeOf(environment) !== Object.prototype || Object.keys(environment).length > 17) fail('invalid_input');
  for (const [key, value] of Object.entries(environment)) {
    if (!/^DISPATCH_[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)
        || (key === 'DISPATCH_MANAGED_RUNTIME' ? value !== '1'
          : !path.isAbsolute(value) || path.resolve(value) !== value)) fail('invalid_input');
  }
  return Object.freeze({ ...fixedEnvironment(), ...environment });
}

function runJson(executable, args, {
  spawn = spawnSync, timeout = 15_000, stdinFd = null, input = null, validate = null, environment = {},
  interpreter = null,
} = {}) {
  executable = safeExecutable(executable);
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) fail('invalid_input');
  if (interpreter !== null && interpreter !== 'node') fail('invalid_input');
  if (input !== null && (typeof input !== 'string' || Buffer.byteLength(input) > 32_768
      || /[\0\r\n]/.test(input) || Number.isInteger(stdinFd))) fail('invalid_input');
  const command = interpreter === 'node' ? process.execPath : executable;
  const commandArgs = interpreter === 'node' ? ['--no-warnings', executable, ...args] : args;
  const result = spawn(command, commandArgs, {
    shell: false,
    env: helperEnvironment(environment),
    encoding: 'utf8',
    timeout,
    maxBuffer: 65_536,
    stdio: [Number.isInteger(stdinFd) ? stdinFd : input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === null ? {} : { input: `${input}\n` }),
  });
  if (result.error?.code === 'ETIMEDOUT') fail('helper_timeout');
  if (result.signal === 'SIGINT' || result.status === 130) fail('cancelled');
  if (result.signal === 'SIGTERM' || result.status === 143) fail('cancelled');
  if (result.error || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 65_536) fail('helper_failed');
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) fail('invalid_helper_response');
  let value;
  try { value = parseStrictJson(lines[0]); } catch { fail('invalid_helper_response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean' || typeof value.status !== 'string') {
    fail('invalid_helper_response');
  }
  if (value.ok !== (result.status === 0)) fail('invalid_helper_response');
  if (value.ok ? value.status !== 'ok' : value.status === 'ok') fail('invalid_helper_response');
  if (!value.ok && Object.keys(value).sort().join(',') !== 'ok,status') fail('invalid_helper_response');
  if (validate && validate(value) !== true) fail('invalid_helper_response');
  return { exitCode: result.status, value };
}

module.exports = { safeExecutable, fixedEnvironment, helperEnvironment, runJson, PROJECT_ROOT, OWNER_HOME };
