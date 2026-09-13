'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { INSTALLATION_MANIFEST_VERSION } = require('../../../shared/contracts/src/installation');
const { hostAccountName } = require('../../runtime-host-identity');
const { OCI_BACKEND, SUBID_COUNT } = require('../src/oci-deployment');
const { createOciContainerAdapter } = require('../src/oci-adapter');

function fixture() {
  const runtimeKey = 'runtime_oci_adapter';
  const manifest = {
    manifestVersion: INSTALLATION_MANIFEST_VERSION,
    revision: 1,
    organization: { id: 'organization_adapter', stationCode: 'DXX1', timezone: 'America/Chicago' },
    runtime: { key: runtimeKey, templateId: 'isolated_dsp_v1', releaseId: 'dispatch-runtime-fixture' },
  };
  const authority = {
    revision: manifest.revision,
    organization: { ...manifest.organization },
    runtime: { ...manifest.runtime },
  };
  const account = {
    runtimeKey,
    name: hostAccountName(runtimeKey),
    uid: 20_001,
    gid: 20_001,
    subuidStart: 1_048_576,
    subgidStart: 1_048_576,
    subidCount: SUBID_COUNT,
    status: 'reserved',
  };
  const release = {
    version: 2,
    backend: OCI_BACKEND,
    releaseId: manifest.runtime.releaseId,
    channel: 'fixture',
    image: `localhost/dispatch-runtime@sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageId: 'f'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    platform: 'linux/amd64',
    runtimeAgentProtocol: 1,
    runtimeGatewayProtocol: 1,
    embeddedManifestSha256: 'c'.repeat(64),
    imageArchiveSha256: 'd'.repeat(64),
    bridgeManifestSha256: 'e'.repeat(64),
  };
  return { manifest, authority, account, release };
}

test('OCI adapter maps the durable pipeline to closed host operations without leaking its token', () => {
  const values = fixture();
  let allocated = null;
  const calls = [];
  const hostRegistry = {
    reserve: () => { allocated = values.account; return allocated; },
    inspect: () => allocated,
  };
  const hostExecutor = {
    prepareAccount: () => ({ changed: true }),
    materializeLayout: (plan, token) => { calls.push(['layout', token]); return { changed: true }; },
    prepareImage: () => ({ changed: true }),
    render: () => ({ changed: true }),
    validate: () => ({ changed: false }),
    install: () => ({ changed: true }),
    start: () => ({ changed: true }),
    health: () => ({ changed: false }),
    commit: () => ({ changed: true }),
    rollback: () => ({ changed: true }),
  };
  const adapter = createOciContainerAdapter({
    hostRegistry,
    hostExecutor,
    releaseResolver: (releaseId, fixtureChannel) => {
      assert.equal(releaseId, values.release.releaseId);
      assert.equal(fixtureChannel, true);
      return values.release;
    },
    credentialPort: { read: () => 'A'.repeat(43) },
  });
  const guard = callback => callback();
  const claim = { jobId: 'job_adapter', workerId: 'worker_adapter', fence: 1, generation: 1 };
  assert.deepEqual(adapter.reconcileHostAccount(
    values.manifest, values.authority, { fixture: true, claim }, guard,
  ), { ociDeploymentPlanVersion: 1, status: 'host_account_ready', changed: true });
  const plan = adapter.plan(values.manifest, values.authority, { fixture: true, claim });
  assert.equal(plan.account.name, values.account.name);
  assert.deepEqual(adapter.reconcileImage(plan, claim, guard),
    { ociDeploymentPlanVersion: 1, status: 'image_ready', changed: true });
  assert.deepEqual(adapter.reconcileBridge(plan, claim, guard),
    { ociDeploymentPlanVersion: 1, status: 'bridge_ready', changed: true });
  assert.deepEqual(adapter.reconcileContainer(plan, claim, guard),
    { ociDeploymentPlanVersion: 1, status: 'container_ready', changed: true });
  assert.deepEqual(adapter.verify(plan, claim),
    { ociDeploymentPlanVersion: 1, status: 'healthy', changed: false });
  assert.equal(JSON.stringify(adapter.verify(plan, claim)).includes('AAAA'), false);
  assert.deepEqual(calls, [['layout', 'A'.repeat(43)]]);
});
