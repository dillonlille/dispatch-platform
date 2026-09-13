'use strict';

const { createOnboardingStore } = require('../../accounts/src/onboarding-store');
const { managedInstallationContext } = require('../../accounts/src/installation-authority');
const crypto = require('node:crypto');
const { MAX_PROVIDER_EVIDENCE_AGE_MS } = require('../../accounts/src/installation-activation');
const { providerEvidence } = require('./activation');
const { setupFailure } = require('../../../shared/contracts/src/paycom-setup');
function fail(code = 'installation_not_ready') { throw Object.assign(new Error(code), { code }); }
function createOwnerOnboardingWorker({ store, invoke, backends = ['oci_container_v1', 'native_service_v1'], clock = Date.now,
  testProvider = null,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const requests = createOnboardingStore(store, clock);
  async function run(id, workerId) {
    const pending = requests.get(id);
    if (!pending || !backends.includes(store.installationBackend(pending.organization_id))) fail();
    const row = requests.claim(id, workerId);
    try {
      const selected = managedInstallationContext(store, row.organization_id);
      function guard() {
        if (!require('../../accounts/src/plugins').available(store, row.organization_id, 'paycom')) fail('plugin_disabled');
        const current = managedInstallationContext(store, row.organization_id);
        if (!backends.includes(current.backend)
            || !['ready', 'waiting_for_provider_auth'].includes(current.installation.status)
            || !['active', 'setup_required'].includes(current.organization.status)
            || !current.ownerActive
            || current.manifest.revision !== row.manifest_revision
            || JSON.stringify(current.manifest) !== JSON.stringify(selected.manifest)
            || current.installation.revision !== selected.installation.revision
            || store.activeLifecycleJob(row.organization_id)
            || store.runningActivationJob(row.organization_id)
            || store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id)) fail();
        requests.renew(row);
      }
      // A claimed retry gets a fresh identity; polling keeps that identity stable.
      const requestId = `setup_${crypto.createHash('sha256').update(`${row.id}:${row.fence}`).digest('hex').slice(0, 32)}`;
      const deadline = clock() + 180_000;
      let command = 'start';
      let step = 'test';
      for (;;) {
        guard();
        const result = step === 'test' && testProvider ? await testProvider(selected.manifest.runtime.key)
          : await invoke(selected.manifest.runtime.key, 'paycom.setup', {
          command, requestId, step, manifest: selected.manifest,
          manifestAuthority: selected.manifestAuthority, parameters: {},
        });
        guard();
        if (!result?.ok && result?.status === 'execution_capacity_wait' && selected.backend === 'directory_service_v1') {
          requests.defer(row);
          return { status: 'queued' };
        }
        if (!result?.ok) fail(setupFailure(result?.status));
        if (result.status === 'succeeded') {
          if (step === 'sync') {
            if (result.data?.syncId !== 'paycom-main-workforce' || result.data.intervalSeconds !== 3600
                || result.data.desiredState !== 'running') fail('runtime_health_failed');
            requests.finish(row);
            return { status: 'succeeded' };
          }
          const evidence = providerEvidence(result.data);
          const testedAt = Date.parse(evidence.testedAt);
          if (testedAt > clock() + 60_000 || clock() - testedAt > MAX_PROVIDER_EVIDENCE_AGE_MS) fail('provider_auth_required');
          step = 'sync';
          command = 'start';
          continue;
        }
        if (result.status !== 'running' || clock() >= deadline) fail('provider_setup_failed');
        command = 'status';
        await delay(1000);
      }
    } catch (error) {
      if (error?.code === 'installation_operation_in_progress') throw error;
      requests.finish(row, setupFailure(error?.code));
      return { status: 'failed' };
    }
  }
  async function runPending(workerId, limit = 20) {
    const candidates = requests.candidates(limit, backends);
    let completed = 0;
    let failed = 0;
    for (const [index, row] of candidates.entries()) {
      try {
        const result = await run(row.id, `${workerId}_${index}`);
        if (result.status === 'succeeded') completed += 1; else if (result.status === 'failed') failed += 1;
      } catch { failed += 1; }
    }
    return { processed: candidates.length, completed, failed };
  }
  return { run, runPending };
}
module.exports = { createOwnerOnboardingWorker };
