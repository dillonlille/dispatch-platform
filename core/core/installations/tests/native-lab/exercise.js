"use strict";
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const execute = require("node:util").promisify(execFile);
const { api, login, tick, read, until, check } = require("./scenarios");
const { seed } = require("./seed");
const LOCAL = "/home/dispatchlab/local";
const user = (script, args = []) =>
  execute(
    "/usr/sbin/runuser",
    [
      "--user",
      "dispatchlab",
      "--",
      "/usr/bin/env",
      "DISPATCH_LOCAL_ROOT=" + LOCAL,
      "/usr/bin/node",
      "--no-warnings",
      script,
      ...args,
    ],
    { timeout: 120000 },
  );
const controls = async (platform) =>
  (await api(platform, "/api/platform/organizations")).value.data;
async function drained() {
  await until(async () => {
    await tick();
    const rows = read((db) =>
      db
        .prepare(
          "SELECT status,failure_code FROM platform_backup_requests WHERE status IN ('queued','running','failed')",
        )
        .all(),
    );
    assert.ok(!rows.some((r) => r.status === "failed"), JSON.stringify(rows));
    return !rows.length;
  }, 600000);
}
async function exercise({ platform, owners }) {
  const rows = read((db) =>
    db
      .prepare(
        "SELECT i.*,o.name FROM installations i JOIN organizations o ON o.id=i.organization_id ORDER BY o.name",
      )
      .all(),
  );
  const plans = [];
  await check(
    "native health and synthetic provider publication activation",
    async () => {
      for (const row of rows) {
        const { plan } = seed(row.organization_id);
        plans.push(plan);
        await user(
          "/work/core/installations/tests/native-lab/activate.js",
          [row.organization_id],
        );
      }
      for (const owner of owners) {
        const daily = await api(owner, "/api/paycom/daily?date=2026-09-05");
        assert.equal(daily.value.status, "found");
        assert.match(
          JSON.stringify(daily.value.data),
          /Synthetic Fixture Employee/,
        );
        await api(owner, "/api/integrations");
      }
    },
  );
  await check(
    "tenant OS identities cannot read peer data or Core secrets",
    async () => {
      for (let i = 0; i < 2; i++) {
        const file = plans[i].host.installationRoot + "/data/lab-marker";
        fs.writeFileSync(file, "tenant-" + i + "-before", { mode: 0o600 });
        fs.chownSync(file, plans[i].account.uid, plans[i].account.gid);
        await assert.rejects(
          execute("/usr/sbin/runuser", [
            "--user",
            plans[i].account.name,
            "--",
            "/usr/bin/cat",
            plans[1 - i].host.installationRoot +
              "/secrets/runtime-agent/registration-token",
          ]),
        );
        await assert.rejects(
          execute("/usr/sbin/runuser", [
            "--user",
            plans[i].account.name,
            "--",
            "/usr/bin/cat",
            LOCAL + "/config/provisioning.env",
          ]),
        );
      }
    },
  );
  await check(
    "anonymous and DSP owner cannot administer platform or peer DSP",
    async () => {
      await api(null, "/api/platform/organizations", undefined, 401);
      await api(owners[0], "/api/platform/organizations", undefined, 403);
      const target = (await controls(platform))[1];
      await api(
        owners[0],
        "/api/platform/organization/status",
        {
          controlRef: target.controlRef,
          suspended: true,
          idempotencyKey: "lab:acceptance:forbidden:suspend",
        },
        403,
      );
      await api(
        { ...platform, csrf: "wrong" },
        "/api/platform/organization/status",
        {
          controlRef: target.controlRef,
          suspended: true,
          idempotencyKey: "lab:acceptance:csrf:suspend",
        },
        403,
      );
    },
  );
  await check(
    "manual sync executes a real collection job and preserves peer service",
    async () => {
      const before = await execute("/usr/bin/systemctl", [
        "show",
        plans[1].identity.unitName,
        "--property=MainPID",
        "--value",
      ]);
      const queued = await api(
        owners[0],
        "/api/paycom/sync",
        { idempotencyKey: "lab_sync_manual_001" },
        202,
      );
      await until(async () => {
        const again = await api(
          owners[0],
          "/api/paycom/sync",
          { idempotencyKey: "lab_sync_manual_001" },
          202,
        );
        assert.equal(again.value.data.run.id, queued.value.data.run.id);
        assert.notEqual(again.value.data.run.status, "failed");
        return again.value.data.run.status === "succeeded";
      }, 30000);
      assert.equal(
        (
          await execute("/usr/bin/systemctl", [
            "show",
            plans[1].identity.unitName,
            "--property=MainPID",
            "--value",
          ])
        ).stdout,
        before.stdout,
      );
    },
  );
  let member;
  await check(
    "custom-role member registers, reads permitted data and cannot administer the DSP",
    async () => {
      const role = (
        await api(
          owners[0],
          "/api/organization/roles",
          {
            name: "Read-only lab member",
            description: "Synthetic role",
            permissions: ["dashboard.view", "workforce.read"],
          },
          201,
        )
      ).value.data;
      await api(
        owners[0],
        "/api/organization/invitations",
        { email: "member0@example.test", roleId: role.id },
        201,
      );
      const message = fs
        .readFileSync(LOCAL + "/inbox.jsonl", "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .find((m) => m.email === "member0@example.test");
      assert.ok(message);
      const registered = await api(
        null,
        "/api/auth/register",
        {
          token: message.token,
          firstName: "Lab",
          lastName: "Member",
          password: "disposable lab password 123",
          confirmPassword: "disposable lab password 123",
        },
        201,
      );
      member = {
        cookie: registered.cookie,
        csrf: registered.value.data.csrfToken,
      };
      await api(member, "/api/paycom/daily?date=2026-09-05");
      await api(
        member,
        "/api/organization/roles",
        { name: "Forbidden", description: "", permissions: ["members.manage"] },
        403,
      );
      await api(
        member,
        "/api/paycom/sync",
        { idempotencyKey: "lab_member_forbidden_sync" },
        403,
      );
    },
  );
  await check(
    "DSP backup requests are idempotent and produce verified encrypted archives",
    async () => {
      const request = {
        action: "backup",
        scope: "dsps",
        organizationIds: rows.map((r) => r.organization_id),
        idempotencyKey: "lab:acceptance:backup:two",
      };
      await api(platform, "/api/platform/backups", request);
      await api(platform, "/api/platform/backups", request);
      await drained();
      assert.equal(
        read(
          (db) =>
            db
              .prepare(
                "SELECT count(*) AS n FROM platform_backup_requests WHERE kind='backup'",
              )
              .get().n,
        ),
        2,
      );
      const catalog = JSON.parse(
        fs.readFileSync("/var/lib/dispatch-backup-receipts/catalog.json"),
      );
      assert.equal(
        Object.values(catalog.backups).filter((r) => r.status === "verified")
          .length,
        2,
      );
    },
  );
  const records = read((db) =>
    db
      .prepare(
        "SELECT * FROM platform_backup_records WHERE kind='dsp' ORDER BY created_at",
      )
      .all(),
  );
  const saved = records.find(
    (r) => r.organization_id === rows[0].organization_id,
  );
  await check(
    "restore rejects the wrong DSP and requires named confirmation",
    async () => {
      await api(
        platform,
        "/api/platform/backups",
        {
          action: "restore",
          organizationId: rows[1].organization_id,
          backupId: saved.id,
          confirmation: rows[1].name,
          idempotencyKey: "lab:acceptance:restore:wrong-tenant",
        },
        409,
      );
      await api(
        platform,
        "/api/platform/backups",
        {
          action: "restore",
          organizationId: rows[0].organization_id,
          backupId: saved.id,
          confirmation: "wrong",
          idempotencyKey: "lab:acceptance:restore:wrong-name",
        },
        409,
      );
    },
  );
  await check(
    "DSP restore hydrates remote archive and restores data without altering peer",
    async () => {
      fs.writeFileSync(
        plans[0].host.installationRoot + "/data/lab-marker",
        "changed after backup",
      );
      await api(platform, "/api/platform/backups", {
        action: "restore",
        organizationId: rows[0].organization_id,
        backupId: saved.id,
        confirmation: rows[0].name,
        idempotencyKey: "lab:acceptance:restore:valid",
      });
      await drained();
      assert.equal(
        fs.readFileSync(
          plans[0].host.installationRoot + "/data/lab-marker",
          "utf8",
        ),
        "tenant-0-before",
      );
      member = await login("member0@example.test");
      await api(member, "/api/paycom/daily?date=2026-09-05");
      assert.equal(
        fs.readFileSync(
          plans[1].host.installationRoot + "/data/lab-marker",
          "utf8",
        ),
        "tenant-1-before",
      );
      await api(owners[0], "/api/paycom/daily?date=2026-09-05", undefined, 401);
      owners[0] = await login("owner0@example.test");
      owners[0].email = "owner0@example.test";
      await api(owners[0], "/api/paycom/daily?date=2026-09-05");
      await api(owners[1], "/api/paycom/daily?date=2026-09-05");
    },
  );
  await check(
    "suspension denies old sessions and new logins and stops only its DSP",
    async () => {
      const target = (await controls(platform)).find(
        (r) => r.name === rows[0].name,
      );
      await api(platform, "/api/platform/organization/status", {
        controlRef: target.controlRef,
        suspended: true,
        idempotencyKey: "lab:acceptance:suspend:one",
      });
      await api(owners[0], "/api/paycom/daily?date=2026-09-05", undefined, 401);
      await api(
        null,
        "/api/auth/login",
        { email: owners[0].email, password: "disposable lab password 123" },
        403,
      );
      await api(member, "/api/paycom/daily?date=2026-09-05", undefined, 401);
      await api(
        null,
        "/api/auth/login",
        {
          email: "member0@example.test",
          password: "disposable lab password 123",
        },
        403,
      );
      await tick();
      assert.equal(
        (
          await execute("/usr/bin/systemctl", [
            "show",
            plans[0].identity.unitName,
            "--property=UnitFileState",
            "--value",
          ])
        ).stdout.trim(),
        "disabled",
      );
      await api(owners[1], "/api/paycom/daily?date=2026-09-05");
    },
  );
  await check("resume restores runtime access with a new session", async () => {
    const target = (await controls(platform)).find(
      (r) => r.name === rows[0].name,
    );
    await api(platform, "/api/platform/organization/status", {
      controlRef: target.controlRef,
      suspended: false,
      idempotencyKey: "lab:acceptance:resume:one",
    });
    await tick();
    await api(owners[0], "/api/paycom/daily?date=2026-09-05", undefined, 401);
    owners[0] = await login("owner0@example.test");
    await api(owners[0], "/api/paycom/daily?date=2026-09-05");
  });
  // Further destructive checks use these verified identities and archive IDs.
  fs.writeFileSync(
    "/root/lab-state.json",
    JSON.stringify({ rows, plans, records }),
    { mode: 0o600 },
  );
}
module.exports = { exercise, drained, controls };
