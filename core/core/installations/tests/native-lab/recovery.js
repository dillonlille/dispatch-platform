"use strict";
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { api, tick, read, check, until } = require("./scenarios");
const recovery = require("../../src/host-recovery-bundle");
const { runFactory, config } = require("./offsite");
const call = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 120000 });
async function disaster({ platform, rows, plans }) {
  await check(
    "full platform backup is exported and independently restored from encrypted storage",
    async () => {
      await api(platform, "/api/platform/backups", {
        action: "backup",
        scope: "core",
        idempotencyKey: "lab:acceptance:backup:core",
      });
      await until(async () => {
        try {
          await tick();
        } catch {}
        const r = read((db) =>
          db
            .prepare("SELECT * FROM platform_backup_requests WHERE kind='core'")
            .get(),
        );
        assert.notEqual(r.status, "failed", JSON.stringify(r));
        return r.status === "completed";
      }, 600000);
      const row = read((db) =>
        db
          .prepare("SELECT * FROM platform_backup_records WHERE kind='core'")
          .get(),
      );
      const rec = JSON.parse(
        fs.readFileSync(
          "/var/lib/dispatch-backup/archives/" + row.id + ".json",
        ),
      );
      runFactory({
        ...config.environment,
        RESTIC_REPOSITORY: `s3:https://fixture/dispatch-lab/archives/${rec.retentionDays === null ? "all" : rec.retentionDays}/${row.id}`,
      })([
        "restore",
        rec.snapshotId,
        "--target",
        "/root/lab-download",
        "--verify",
      ]);
      fs.writeFileSync(
        "/root/lab-recovery-state.json",
        JSON.stringify({ row, rec, rows, plans }),
      );
    },
  );
  const directory = "/root/lab-download/bundle/recovery",
    proof = JSON.parse(
      fs.readFileSync("/root/lab-download/bundle/recovery-proof.json"),
    );
  const manifest = JSON.parse(fs.readFileSync(directory + "/recovery.json"));
  await check(
    "full recovery includes the privileged-operation caller account",
    async () =>
      assert.ok(
        manifest.metadata.accounts.some((a) => a.name === "dispatchhelper"),
      ),
  );
  await check(
    "corrupt recovery metadata and occupied destination fail before changing live data",
    async () => {
      await assert.rejects(
        recovery.restoreHostRecovery({
          directory,
          digest: "0".repeat(64),
          installPackages: false,
        }),
      );
      await assert.rejects(
        recovery.restoreHostRecovery({
          directory,
          digest: proof.sha256,
          installPackages: false,
        }),
      );
      for (let i = 0; i < plans.length; i++)
        assert.equal(
          fs.readFileSync(
            plans[i].host.installationRoot + "/data/lab-marker",
            "utf8",
          ),
          "tenant-" + i + "-before",
        );
    },
  );
  await check(
    "complete host loss restores accounts, code, secrets, DSP data and running services",
    async () => {
      for (const service of manifest.metadata.services)
        recovery.systemctl(service, ["disable", "--now", service.name]);
      call("/usr/bin/loginctl", ["disable-linger", "dispatchlab"]);
      call("/usr/bin/systemctl", ["stop", "user@1001.service"]);
      for (const a of manifest.metadata.accounts) {
        call("/usr/sbin/userdel", [a.name]);
        try {
          call("/usr/sbin/groupdel", [a.name]);
        } catch {}
      }
      for (const root of manifest.roots)
        fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync("/home/dispatchlab", { recursive: true, force: true });
      fs.rmSync("/var/lib/dispatch-backup", { recursive: true, force: true });
      for (const parent of ["/opt/dispatch-platform", "/opt/dispatch-runtime", "/opt/dispatch-control", "/var/lib/dispatch/tenants"])
        fs.rmSync(parent, { recursive: true, force: true });

      const priorUmask = process.umask(0o077);
      try {
        await recovery.restoreHostRecovery({
          directory,
          digest: proof.sha256,
          installPackages: false,
        });
      } finally { process.umask(priorUmask); }
      for (let i = 0; i < plans.length; i++)
        assert.equal(
          fs.readFileSync(
            plans[i].host.installationRoot + "/data/lab-marker",
            "utf8",
          ),
          "tenant-" + i + "-before",
        );
    },
  );
  // Recovery download is sensitive history too; erase it before DSP deletion.
  fs.rmSync("/root/lab-download", { recursive: true, force: true });
  // Model a transfer whose process was killed before its finally cleanup ran.
  const interrupted = fs.mkdtempSync("/var/lib/dispatch-backup/archive-transfer-");
  fs.writeFileSync(interrupted + "/tenant-history", "synthetic interrupted backup");
  fs.writeFileSync("/root/lab-interrupted-transfer", interrupted);
}
module.exports = { disaster };
