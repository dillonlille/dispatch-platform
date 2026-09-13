'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createOciHostAuthority } = require('./oci-host-authority');
const { loadConfig, OCI_HOST_HELPER_OPERATIONS } = require('./oci-host-helper');
const { verifyHostArtifact, readRootFile } = require('./oci-host-artifact');
const { opaqueRuntimeSuffix } = require('../../runtime-host-identity');
const { createOciHostAccountRegistry } = require('./oci-host-account-registry');

const ISSUER_COMMAND = '/opt/dispatch-control/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-issuer';
const HELPER_COMMAND = '/opt/dispatch-control/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-helper';
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
function fail() { throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' }); }
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', env: ENV, timeout: 30_000,
    maxBuffer: 256 * 1024, ...options });
  if (result.error || result.signal || ![0, ...(options.accepted || [])].includes(result.status)) fail();
  return result;
}
function state(unit) {
  const result = command('/usr/bin/systemctl', ['show', unit,
    '--property=LoadState,ActiveState,SubState,Job,ControlGroup,FragmentPath,DropInPaths'], { accepted: [1] });
  return Object.fromEntries(result.stdout.trim().split('\n').map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
}
function stopped(unit) {
  const value = state(unit);
  if (value.Job || !['inactive', 'failed'].includes(value.ActiveState)
      || !['dead', 'failed'].includes(value.SubState)) fail();
  if (value.ControlGroup) {
    if (!/^\/(?:system|dispatch-dsp).slice\/dispatch-[a-z0-9-]+\.service$/.test(value.ControlGroup)) fail();
    try {
      const events = fs.readFileSync(`/sys/fs/cgroup${value.ControlGroup}/cgroup.events`, 'utf8');
      if (!/^populated 0$/m.test(events)) fail();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function recoverHost(runtimeKey, ids, config) {
  // These IDs came from the root ledger, never from a caller-selected unit.
  for (const id of ids) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail();
    const unit = `dispatch-host-action-${id}.service`;
    command('/usr/bin/systemctl', ['stop', unit], { accepted: [5] });
    stopped(unit);
  }
  const suffix = opaqueRuntimeSuffix(runtimeKey);
  for (const unit of [`dispatch-dsp-${suffix}.service`, `dispatch-runtime-agent-bridge-${suffix}.service`]) {
    const value = state(unit);
    if (value.LoadState !== 'not-found') {
      const expected = `/etc/systemd/system/${unit}`;
      if (value.FragmentPath !== expected || value.DropInPaths) fail();
      readRootFile(expected, 0o644, 64 * 1024);
      command('/usr/bin/systemctl', ['stop', unit]);
    }
    stopped(unit);
  }
  const registry = createOciHostAccountRegistry({ stateRoot: config.stateRoot, identityAvailable: () => false });
  let account;
  try { account = registry.inspect(runtimeKey); } finally { registry.close(); }
  if (account && ['reserved', 'active'].includes(account.status)) {
    const passwd = command('/usr/bin/getent', ['passwd', account.name], { accepted: [2] });
    if (passwd.status === 0) {
      const fields = passwd.stdout.trim().split(':');
      const root = `/var/lib/dispatch/tenants/${suffix}`;
      if (Number(fields[2]) !== account.uid || Number(fields[3]) !== account.gid
          || fields[5] !== `${root}/home` || fields[6] !== '/usr/sbin/nologin') fail();
      let runtimeDirectory;
      try { runtimeDirectory = fs.lstatSync(`/run/user/${account.uid}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (runtimeDirectory && (!runtimeDirectory.isDirectory() || runtimeDirectory.uid !== account.uid
          || runtimeDirectory.gid !== account.gid || (runtimeDirectory.mode & 0o7777) !== 0o700)) fail();
      if (account.status === 'active' && runtimeDirectory) command('/usr/sbin/runuser', ['--user', account.name, '--', '/usr/bin/env', '-i',
        `HOME=${root}/home`, `XDG_DATA_HOME=${root}/engine-data`, `XDG_CONFIG_HOME=${root}/engine-config`,
        `XDG_RUNTIME_DIR=/run/user/${account.uid}`, 'PATH=/usr/bin:/bin', '/usr/bin/podman',
        'rm', '--force', '--ignore', `dispatch-dsp-${suffix}`, `dispatch-dsp-${suffix}-manifest`, `dispatch-dsp-${suffix}-publication`]);
    }
    // Destruction can remove passwd/runtime-dir before its action receipt.
    // Quiescence still covers the reserved numeric allocation in that case.
    command('/usr/bin/loginctl', ['terminate-user', String(account.uid)], { accepted: [1] });
    command('/usr/bin/systemctl', ['stop', `user@${account.uid}.service`, `user-runtime-dir@${account.uid}.service`]);
    // No process in this allocation may survive recovery, including a
    // rootless container or user-manager scope delegated outside the action.
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^[1-9][0-9]*$/.test(entry)) continue;
      let status;
      try { status = fs.readFileSync(`/proc/${entry}/status`, 'utf8'); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
      if (/^State:\s+Z\b/m.test(status)) continue;
      const uids = /^Uid:\s+([0-9\s]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number) || [];
      if (uids.some(uid => uid === account.uid || uid >= account.subuidStart && uid < account.subuidStart + account.subidCount)) fail();
    }
    // Leave the manager stopped. Only a subsequent authorized image/start
    // action may restart tenant work after the old running gate is closed.
  }
  return true;
}

function dispatchAuthorized(request) {
  if (process.geteuid() !== 0 || process.getegid() !== 0) fail();
  const config = loadConfig();
  if (process.env.SUDO_UID !== String(config.authorityUid)) fail();
  verifyHostArtifact(fs.realpathSync(process.argv[1]), config.controlReleaseId,
    config.helperManifestSha256, 'dispatch-oci-host-issuer');
  if (!request || Object.keys(request).sort().join(',') !== 'lease,request,version' || request.version !== 1
      || !request.request || request.request.authorization !== undefined
      || !OCI_HOST_HELPER_OPERATIONS.includes(request.request.operation)) fail();
  const authority = createOciHostAuthority({ root: config.authorityRoot });
  const runtimeKey = request.lease?.runtimeKey;
  let issued = false;
  try {
    authority.recover(runtimeKey, ids => recoverHost(runtimeKey, ids, config));
    authority.synchronizeLease(request.lease, request.request.operation);
    issued = true;
    const authorization = authority.issueAction(request.request);
    const unit = `dispatch-host-action-${authorization}.service`;
    const remaining = request.lease.expiresAt - Date.now();
    if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 600_000) fail();
    const result = command('/usr/bin/systemd-run', [
      '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`,
      '--property=Type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=10s',
      `--property=RuntimeMaxSec=${remaining}ms`, `--property=User=${config.helperCallerUid}`,
      `--property=Group=${config.helperCallerGid}`, '--property=UMask=0077',
      '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8',
      '/usr/bin/sudo', '-n', HELPER_COMMAND,
    ], { input: `${JSON.stringify({ ...request.request, authorization })}\n`,
      timeout: remaining + 20_000, accepted: [1] });
    stopped(unit);
    let response;
    try { response = JSON.parse(result.stdout); } catch { fail(); }
    if (!response || typeof response.ok !== 'boolean') fail();
    if (response.ok && Object.keys(response).sort().join(',') !== 'ok,result') fail();
    if (!response.ok) {
      try { authority.recover(runtimeKey, ids => recoverHost(runtimeKey, ids, config)); }
      catch { /* The durable running gate remains closed for the next recovery. */ }
    }
    if (response.ok && request.request.operation === 'verify_destroyed') authority.revoke(runtimeKey, true);
    return response;
  } finally {
    try { if (issued) authority.revoke(runtimeKey); } finally { authority.close(); }
  }
}

module.exports = { ISSUER_COMMAND, dispatchAuthorized };
