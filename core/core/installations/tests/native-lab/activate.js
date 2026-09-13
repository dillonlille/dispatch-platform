"use strict";
// Provider authentication/publication receipts are synthetic in this mode.
// The activation authority, transitions, evidence validation and health calls are real.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { AccessStore } = require("../../../accounts/src");
const {
  runManagedPaycomActivation,
  ACTIVATION_INFRASTRUCTURE_GATES,
} = require("../../src/activation");
const {
  runtimeAgentControlInvoke,
} = require("../../../agents/src/control");
const {
  INSTALLATION_ACTIVATION_RUNS,
} = require("../../../../shared/contracts/src");
async function main() {
  const organizationId = process.argv[2],
    root = process.env.DISPATCH_LOCAL_ROOT;
  const store = new AccessStore({
    databaseRoot: root + "/data/access-control",
    database: root + "/data/access-control/access-control.sqlite3",
  });
  try {
    // DSP onboarding is complete before optional provider fixture activation.
    assert.equal(store.installationControl(organizationId).status, "ready");
    const requests = require("../../../accounts/src/onboarding-store").createOnboardingStore(store);
    const actor = store.db.prepare("SELECT m.user_id FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.organization_id=? AND m.status='active' AND r.key='owner'").get(organizationId).user_id;
    const row = store.transaction(() => {
      const request = requests.begin(organizationId, actor, "lab:optional:" + require("node:crypto").randomUUID(), "create", store.installationControl(organizationId).manifestRevision);
      requests.enrolled(request.id);
      return requests.claim(request.id, "worker_lab_activation");
    });
    const authority = require("../../../accounts/src/optional-paycom-activation").createOptionalPaycomActivation({ store, row, requests });
    const context = authority.inspect(),
      key = context.manifest.runtime.key;
    const seed = JSON.parse(
      fs.readFileSync(root + "/seed-" + organizationId + ".json"),
    );
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
    const audited = {
      definitionDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      previewDigest: "c".repeat(64),
      batchId: "batch_lab_" + organizationId,
      preparationRunId: "run_periods_fixture",
      target: "2026-09-05",
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
    const result = await runManagedPaycomActivation({
      authority,
      runtime: {
        verifyInfrastructure: async () => {
          const health = await runtimeAgentControlInvoke(
            root + "/run/runtime-agent-control.sock",
            key,
            "health",
            {},
          );
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
        configure: async () => ({
          digest: audited.definitionDigest,
          collectors: 1,
          sources: 1,
          plans: 15,
          syncs: 1,
        }),
        publishFirst: async () => ({
          batchId: audited.batchId,
          preparationRunId: audited.preparationRunId,
          status: "succeeded",
          runCount: runs.length,
          succeededRuns: runs.length,
          failedRuns: 0,
          cancelledRuns: 0,
        }),
        verifyPublication: async () => audited,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const started = await runtimeAgentControlInvoke(
      root + "/run/runtime-agent-control.sock",
      key,
      "sync.start",
      { id: "paycom-main-workforce" },
    );
    assert.equal(started.ok, true);
    requests.finish(row);
    console.log(JSON.stringify(result));
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
