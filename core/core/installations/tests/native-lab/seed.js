"use strict";
// Root-only, VM-only fixture boundary. Uses the DSP identity and real provider stores.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createPlan } = require("../../src/native-deployment");
function seed(organizationId, changed = false) {
  if (os.hostname() !== "dispatch-dsp-lab" || process.geteuid() !== 0)
    throw Error("disposable_vm_required");
  const config = JSON.parse(fs.readFileSync("/root/lab-config.json"));
  const db = new DatabaseSync(
    config.localRoot + "/data/access-control/access-control.sqlite3",
    { readOnly: true },
  );
  let row;
  try {
    row = db
      .prepare(
        "SELECT i.*,o.timezone,s.code AS station FROM installations i JOIN organizations o ON o.id=i.organization_id JOIN stations s ON s.organization_id=o.id AND s.is_primary=1 WHERE o.id=?",
      )
      .get(organizationId);
  } finally {
    db.close();
  }
  const registry = new DatabaseSync(
    "/var/lib/dispatch-host/state/oci-host.sqlite3",
    { readOnly: true },
  );
  let a;
  try {
    a = registry
      .prepare("SELECT * FROM allocations WHERE runtime_key=?")
      .get(row.runtime_key);
  } finally {
    registry.close();
  }
  const manifest = {
    manifestVersion: 1,
    revision: row.manifest_revision,
    organization: {
      id: organizationId,
      stationCode: row.station,
      timezone: row.timezone,
    },
    runtime: {
      key: row.runtime_key,
      templateId: "isolated_dsp_v1",
      releaseId: row.release_id,
    },
  };
  const plan = createPlan(
    manifest,
    {
      revision: manifest.revision,
      organization: manifest.organization,
      runtime: manifest.runtime,
    },
    config.release,
    {
      name: a.account_name,
      uid: a.uid,
      gid: a.gid,
      subuidStart: a.subuid_start,
      subgidStart: a.subgid_start,
      subidCount: 65536,
    },
    {
      version: 1,
      backend: "native_service_v1",
      channel: "production",
      organizationId,
      runtimeKey: row.runtime_key,
      manifestRevision: manifest.revision,
      releaseId: row.release_id,
    },
  );
  const artifact = `/opt/dispatch-runtime/releases/${row.release_id}/runtime-artifact`;
  const args = [
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    `--unit=dispatch-lab-seed-${Date.now()}`,
    ...Object.entries({
      User: plan.account.name,
      Group: plan.account.name,
      ProtectSystem: "strict",
      ProtectHome: "true",
      PrivateTmp: "true",
      BindReadOnlyPaths: artifact + ":/opt/dispatch",
      BindPaths: plan.host.installationRoot + ":" + plan.guest.installationRoot,
      WorkingDirectory: "/opt/dispatch",
      UMask: "0077",
    }).flatMap(([k, v]) => ["--property", k + "=" + v]),
    ...Object.entries({
      ...plan.guest.environment,
      PATH: "/opt/dispatch/dependencies/node/bin:/usr/bin:/bin",
    }).flatMap(([k, v]) => ["--setenv", k + "=" + v]),
    artifact + "/dependencies/node/bin/node",
    "--no-warnings",
    "/opt/dispatch/fixture-seed.js",
    ...(changed ? ["--changed"] : []),
  ];
  const output = execFileSync("/usr/bin/systemd-run", args, {
    encoding: "utf8",
    timeout: 60000,
  });
  const proof = JSON.parse(output.trim());
  const file = config.localRoot + "/seed-" + organizationId + ".json";
  fs.writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
  fs.chownSync(file, 1001, 1001);
  return { plan, proof };
}
if (require.main === module)
  console.log(
    JSON.stringify(seed(process.argv[2], process.argv[3] === "changed")),
  );
module.exports = { seed };
