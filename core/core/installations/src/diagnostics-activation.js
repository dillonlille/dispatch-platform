"use strict";
// Synthetic provider evidence is restricted to explicitly created diagnostic DSPs.
const assert = require("node:assert/strict");
const {
  createAccessInstallationActivationAuthority,
} = require("../../accounts/src/installation-activation");
const {
  runManagedPaycomActivation,
  ACTIVATION_INFRASTRUCTURE_GATES,
} = require("./activation");
const {
  INSTALLATION_ACTIVATION_RUNS,
} = require("../../../shared/contracts/src");
async function activateSyntheticDsp({
  store,
  organizationId,
  workerId,
  invoke,
}) {
  if (
    !store.db
      .prepare("SELECT 1 FROM diagnostic_dsps WHERE organization_id=?")
      .get(organizationId)
  )
    throw new Error("diagnostic_dsp_required");
  const authority = createAccessInstallationActivationAuthority({
    store,
    organizationId,
    authorityScope: "platform_diagnostics",
    workerId,
    idempotencyKey: "diagnostics:activation:" + organizationId,
    releaseId: store.installationControl(organizationId).releaseId,
  });
  const context = authority.inspect(),
    key = context.manifest.runtime.key;
  let audited;
  function audit(seed) {
    const runs = INSTALLATION_ACTIVATION_RUNS.map((run, i) => ({
      id: `run_fixture_${i}`,
      taskId: run.taskId,
      plan: run.plan,
      method: run.method,
    }));
    const pub = (value, runId, originRunId) => ({
      id: value.publicationId,
      runId,
      originRunId,
      contentSha256: value.contentSha256,
      batchBound: true,
    });
    return {
      definitionDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      previewDigest: "c".repeat(64),
      batchId: "batch_lab_" + organizationId,
      preparationRunId: "run_periods_fixture",
      target: seed.target || "2026-09-05",
      runs,
      publications: {
        payPeriods: {
          id: seed.payPeriods.publicationId,
          runId: "run_periods_fixture",
          originRunId: "run_periods_fixture",
          contentSha256: seed.payPeriods.contentSha256,
          batchBound: false,
        },
        roster: pub(seed.roster, runs[0].id, "run_fixture_roster"),
        timecards: pub(seed.timecards, runs[1].id, "run_fixture_timecards"),
        resourceLinks: pub(seed.links, runs[3].id, "run_fixture_links"),
      },
      capturedAt: new Date().toISOString(),
    };
  }
  const result = await runManagedPaycomActivation({
    authority,
    runtime: {
      verifyInfrastructure: async () => {
        const health = await invoke(key, "health", {});
        assert.equal(health.ok, true);
        return {
          runtimeKey: key,
          ...Object.fromEntries(
            ACTIVATION_INFRASTRUCTURE_GATES.map((k) => [k, true]),
          ),
        };
      },
      testProvider: async () => ({
        profileId: "paycom-main",
        provider: "paycom",
        status: "authenticated",
        testedAt: new Date().toISOString(),
      }),
      configure: async () => {
        const response = await invoke(key, "diagnostics.seed", {
          requestId: organizationId,
        });
        if (!response?.ok)
          throw Object.assign(new Error("first_publication_failed"), {
            code: "first_publication_failed",
          });
        audited = audit(response.data);
        return {
          digest: audited.definitionDigest,
          collectors: 1,
          sources: 1,
          plans: 15,
          syncs: 1,
        };
      },
      publishFirst: async () => ({
        batchId: audited.batchId,
        preparationRunId: audited.preparationRunId,
        status: "succeeded",
        runCount: audited.runs.length,
        succeededRuns: audited.runs.length,
        failedRuns: 0,
        cancelledRuns: 0,
      }),
      verifyPublication: async () => audited,
    },
  });
  return result;
}
module.exports = { activateSyntheticDsp };
