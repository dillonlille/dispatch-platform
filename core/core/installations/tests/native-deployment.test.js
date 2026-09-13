'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createOciDeploymentPlan, validateOciDeploymentPlan, renderOciSystemUnit, hostAccountName, podmanArguments } = require('../src/oci-deployment');
const { configuration, assertMountBoundary } = require('dispatch-dsp/runtime/supervisor/src/supervisor.js');
function plan(key) {
  const manifest = { manifestVersion: 1, revision: 1,
    organization: { id: `org_${key}`, stationCode: 'DXX1', timezone: 'America/Chicago' },
    runtime: { key, templateId: 'isolated_dsp_v1', releaseId: 'dispatch_1.0.0' } };
  const authority = { revision: 1, organization: manifest.organization, runtime: manifest.runtime };
  const release = { version: 1, backend: 'native_service_v1', releaseId: 'dispatch_1.0.0', channel: 'production', sourceCommit: 'a'.repeat(40),
    platform: 'linux/amd64', runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1, artifactSha256: 'b'.repeat(64),
    embeddedManifestSha256: 'c'.repeat(64), bridgeManifestSha256: 'd'.repeat(64) };
  const account = { name: hostAccountName(key), uid: key.endsWith('alpha') ? 20001 : 20002, gid: key.endsWith('alpha') ? 20001 : 20002,
    subuidStart: 300000, subgidStart: 300000, subidCount: 65536 };
  return createOciDeploymentPlan(manifest, authority, release, account, { version: 1, backend: release.backend, channel: release.channel,
    organizationId: manifest.organization.id, runtimeKey: key, manifestRevision: 1, releaseId: release.releaseId });
}
test('native DSP services share pinned code and keep independent accounts, data and private browser transport', () => {
  const a = plan('runtime_alpha'), b = plan('runtime_beta');
  assert.notEqual(a.account.uid, b.account.uid);
  assert.notEqual(a.host.installationRoot, b.host.installationRoot);
  const unit = renderOciSystemUnit(a);
  assert.match(unit, /\/opt\/dispatch-runtime\/releases\/dispatch_1.0.0\/runtime-artifact:/);
  assert.match(unit, /DISPATCH_RUNTIME_BACKEND=native_service_v1/);
  assert.match(unit, /^ExecStart=\/opt\/dispatch-runtime\/releases\/dispatch_1\.0\.0\/runtime-artifact\/dependencies\/node\/bin\/node /m);
  assert.match(unit, /TemporaryFileSystem=\/tmp:rw,noexec,nosuid,nodev/);
  assert.doesNotMatch(unit, /Exec\w*=.*(?:podman|docker)|RootImage|remote-debugging-port/);
  assert.match(unit, /InaccessiblePaths=-\/run\/docker.sock -\/run\/podman/);
  assert.deepEqual(validateOciDeploymentPlan(JSON.parse(JSON.stringify(a))), a);
  assert.throws(() => validateOciDeploymentPlan({ ...a, host: b.host }), /runtime_boundary_violation/);
  assert.throws(() => podmanArguments(a), /runtime_boundary_violation/);
  const config = configuration(a.guest.environment);
  const mount = (point, options) => `1 0 0:1 / ${point} ${options} - tmpfs tmpfs rw`;
  const mounts = [['/', 'ro'], ['/opt/dispatch', 'ro'], [a.guest.installationRoot, 'rw'], ['/run/dispatch-agent', 'ro'], ['/tmp', 'rw,noexec,nosuid,nodev']];
  assert.equal(assertMountBoundary(config, mounts.map(([p, m]) => mount(p, m)).join('\n'), () => false), true);
  assert.throws(() => assertMountBoundary(config, mounts.filter(([p]) => p !== '/opt/dispatch').map(([p, m]) => mount(p, m)).join('\n'), () => false));
});
