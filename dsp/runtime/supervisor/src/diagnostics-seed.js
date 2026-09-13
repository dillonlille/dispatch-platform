"use strict";
// A fixed private Runtime Agent command: no scripts, paths, or employee data from HTTP.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { success, failure } = require("dispatch-protocol/contracts/src/result");
const { ensurePrivateDirectory } = require("../../auth-broker/src/vault");
const {
  PaycomStore,
  stageCandidate,
  cleanupStage,
} = require("../../../plugins/paycom/backend/src/store");
const { periodFromEnd } = require("../../../plugins/paycom/backend/src/timecard-period");
const {
  TIMECARD_SUMMARY,
  ROUTE_VERSION,
  linkRows,
} = require("../../../plugins/paycom/backend/src/resource-links");
const { timecardRecord, rosterRow } = require("./diagnostics-data");
function createDiagnosticsSeed(config) {
  return ({ requestId }) => {
    if (
      !/^org_[a-f0-9]{32}$/.test(requestId) ||
      ![`runtime_${requestId.slice(4)}`, `dsp_${requestId.slice(4)}`].includes(config.runtimeKey)
    )
      return failure("runtime_identity_mismatch");
    const root = path.join(config.layout.directories.stateRoot, "diagnostics");
    ensurePrivateDirectory(root);
    const receipt = path.join(root, "seed.json");
    let previous;
    if (fs.existsSync(receipt)) {
      const info = fs.lstatSync(receipt);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.geteuid() ||
        (info.mode & 0o777) !== 0o600
      )
        return failure("runtime_boundary_violation");
      previous = JSON.parse(fs.readFileSync(receipt, "utf8"));
      if (previous.requestId !== requestId)
        return failure("runtime_identity_mismatch");
      if (previous.data) return success("succeeded", previous.data);
    }
    const store = new PaycomStore(config.paths.paycom.database);
    try {
      // A regular DSP with existing publications can never be converted into a fixture.
      if (
        !previous &&
        store.db.prepare("SELECT 1 FROM publications LIMIT 1").get()
      )
        return failure("installation_operation_not_allowed");
      const end = new Date();
      end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
      const target = previous?.target || end.toISOString().slice(0, 10);
      const write = (value) => {
        const temporary =
          receipt + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
        const fd = fs.openSync(
          temporary,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, JSON.stringify(value));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, receipt);
      };
      const collectedAt = previous?.collectedAt || new Date().toISOString();
      write({ requestId, target, collectedAt });
      const period = periodFromEnd(target);
      const STAGING_ROOT = config.paths.paycom.stagingRoot;
      function publish(candidate) {
        const stage = stageCandidate(STAGING_ROOT, {
          attempt: 1,
          collectedAt,
          ...candidate,
          runId: candidate.runId,
        });
        try {
          return store.publish(stage);
        } finally {
          cleanupStage(stage, STAGING_ROOT);
        }
      }
      const payPeriods = publish({
        kind: "pay_periods",
        target: period.end,
        runId: "run_periods_fixture",
        metadata: {},
        rows: [
          {
            start: period.start,
            end: period.end,
            key: period.key,
            relation: "current",
          },
        ],
      });
      const rows = [
        rosterRow("Z999", "Synthetic Test Driver"),
        rosterRow("Z998", "Synthetic Test Dispatcher"),
      ];
      const roster = publish({
        kind: "roster",
        target: period.end,
        runId: "run_fixture_roster",
        metadata: {},
        rows,
      });
      const timecards = publish({
        kind: "timecards",
        target: period.end,
        periodKey: period.key,
        runId: "run_fixture_timecards",
        metadata: {
          periodStart: period.start,
          periodEnd: period.end,
          mode: "full",
          rosterPublicationId: roster.publicationId,
          rosterContentSha256: roster.contentSha256,
        },
        rows: rows.map((row) => ({
          employeeCode: row.employeeCode,
          employeeName: row.employeeName,
          record: timecardRecord(row.employeeCode, period.end),
          sourceSha256: "b".repeat(64),
        })),
      });
      const links = publish({
        kind: "resource_links",
        target: period.end,
        periodKey: period.key,
        runId: "run_fixture_links",
        metadata: {
          resourceType: TIMECARD_SUMMARY,
          periodStart: period.start,
          periodEnd: period.end,
          rosterPublicationId: roster.publicationId,
          rosterContentSha256: roster.contentSha256,
          routeVersion: ROUTE_VERSION,
        },
        rows: linkRows(TIMECARD_SUMMARY, rows, period),
      });

      {
        const {
          CollectionStore,
        } = require("dispatch-runtime-kit/collection-manager/src/store");
        const {
          materializeSpec,
        } = require("../../collection-manager/src/control-cli");
        const spec = JSON.parse(
          fs.readFileSync(
            path.resolve(
              __dirname,
              "../../../plugins/paycom/backend/config/collection-manager.json",
            ),
          ),
        );
        for (const sync of spec.syncs || []) sync.desiredState = "stopped";
        for (const plan of spec.plans) plan.schedule = { type: "manual" };
        const collection = new CollectionStore(config.paths.collection);
        try {
          collection.applySpec(materializeSpec(spec, config.paths.projectRoot));
        } finally {
          collection.close();
        }
      }

      const data = { target, payPeriods, roster, timecards, links };
      write({ requestId, target, collectedAt, data });
      return success("succeeded", data);
    } finally {
      store.close();
    }
  };
}
module.exports = { createDiagnosticsSeed };
