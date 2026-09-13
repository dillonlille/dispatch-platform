'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { opaqueRuntimeSuffix, hostAccountName } = require('../../runtime-host-identity');
function fixture({ passwdPresent = true, liveSubuid = false } = {}) {
  const key = 'runtime_interrupted_destroy', suffix = opaqueRuntimeSuffix(key), calls = [];
  const account = { name: hostAccountName(key), uid: 29998, gid: 29998, subuidStart: 500000, subidCount: 65536, status: 'active' };
  const file = path.resolve(__dirname, "../src/oci-host-issuer.js");
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const realRequire = Module.createRequire(file);
  loaded.require = name => {
    if (name === 'node:fs') return {
      lstatSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      readdirSync: () => ['123'],
      readFileSync: () => `State:\tS (sleeping)\nUid:\t${liveSubuid ? '500001' : '0'} 0 0 0\n`,
    };
    if (name === './oci-host-account-registry') return { createOciHostAccountRegistry: () => ({ inspect: () => account, close() {} }) };
    if (name === 'node:child_process') return { spawnSync: (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/getent') return { status: passwdPresent ? 0 : 2,
        stdout: passwdPresent ? `${account.name}:x:${account.uid}:${account.gid}::/var/lib/dispatch/tenants/${suffix}/home:/usr/sbin/nologin\n` : '' };
      return { status: 0, stdout: args[0] === 'show' ? 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\nControlGroup=\n' : '' };
    } };
    return realRequire(name);
  };
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.recoverHost = recoverHost;\n', file);
  return { recover: () => loaded.exports.recoverHost(key, ['a'.repeat(64)], { stateRoot: '/unused' }), calls };
}
for (const passwdPresent of [true, false]) test(`interrupted destroy recovers absent runtime directory with passwd ${passwdPresent}`, () => {
  const f = fixture({ passwdPresent });
  assert.equal(f.recover(), true);
  assert.equal(f.calls.some(([, args]) => args.includes('/usr/bin/podman')), false);
  assert.equal(f.calls.some(([, args]) => args.includes('user@29998.service')), true);
});
test('recovery still refuses live subordinate processes after passwd deletion', () => {
  const f = fixture({ passwdPresent: false, liveSubuid: true });
  assert.throws(f.recover, /runtime_boundary_violation/);
});
