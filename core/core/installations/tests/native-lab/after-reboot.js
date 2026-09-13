"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { api, login, tick, read, check, until, report } = require("./scenarios");
const { controls } = require("./exercise");
const call = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 120000 }).trim();
async function main() {
  assert.equal(os.hostname(), "dispatch-dsp-lab");
  assert.equal(process.geteuid(), 0);
  Object.assign(report, JSON.parse(fs.readFileSync("/root/lab-report.json")));
  const { rows, plans, records } = JSON.parse(
    fs.readFileSync("/root/lab-state.json"),
  );
  await check(
    "restored Core and DSPs restart automatically after a real reboot",
    async () => {
      assert.notEqual(
        fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
        fs.readFileSync("/root/lab-boot-id", "utf8"),
      );
      for (let i = 0; i < 2; i++) {
        await until(async () => {
          try {
            const owner = await login(`owner${i}@example.test`);
            return (await api(owner, "/api/paycom/daily?date=2026-09-05")).value
              .ok;
          } catch {
            return false;
          }
        }, 120000);
        assert.equal(
          call("/usr/bin/systemctl", ["is-active", plans[i].identity.unitName]),
          "active",
        );
      }
    },
  );
  await check("reboot removes interrupted backup transfer history", async () => {
    const interrupted = fs.readFileSync("/root/lab-interrupted-transfer", "utf8");
    await until(async () => !fs.existsSync(interrupted));
  });
  await check(
    "restored DSP Chrome uses a private pipe and cannot read peer data",
    async () => {
      const first = plans[0],
        second = plans[1];
      const pid = call("/usr/bin/systemctl", [
        "show",
        first.identity.unitName,
        "--property=MainPID",
        "--value",
      ]);
      assert.match(pid, /^[1-9][0-9]*$/);
      const probe = `const fs=require('node:fs');const {ChromeBrowserRuntime}=require('/opt/dispatch/runtime/auth-broker/src/browser-runtime');const {createTarget,CdpConnection}=require('/opt/dispatch/runtime/auth-broker/src/cdp');(async()=>{const browser=await new ChromeBrowserRuntime({stateRoot:process.env.DISPATCH_AUTH_STATE_ROOT,socketRoot:process.env.DISPATCH_RUNTIME_ROOT,executable:'/opt/dispatch/dependencies/browser/chrome',transport:'pipe'}).launch();try{const target=await createTarget(browser.endpoint,'about:blank');const c=await CdpConnection.connect(target.webSocketDebuggerUrl);try{if(await c.evaluate('6*7')!==42)throw Error('browser_evaluation_failed');}finally{c.close();}if(fs.existsSync(${JSON.stringify(second.host.installationRoot)}))throw Error('peer_data_visible');console.log('private_chrome_passed');}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});`;
      assert.equal(
        call("/usr/bin/nsenter", [
          "--target",
          pid,
          "--mount",
          `--setuid=${first.account.uid}`,
          `--setgid=${first.account.gid}`,
          "--",
          "/usr/bin/env",
          "-i",
          "PATH=/opt/dispatch/dependencies/node/bin:/usr/bin:/bin",
          "HOME=/tmp",
          ...Object.entries(first.guest.environment).map(
            ([k, v]) => `${k}=${v}`,
          ),
          "/opt/dispatch/dependencies/node/bin/node",
          "--no-warnings",
          "-e",
          probe,
        ]),
        "private_chrome_passed",
      );
    },
  );
  const platform = await login("platform@example.test");
  async function removeForDeletion(row) {
    if (row.installation.state !== 'decommissioned') {
      await api(platform, '/api/platform/installation/remove', {
        controlRef: row.controlRef, expectedRevision: row.installation.revision,
        idempotencyKey: 'lab:acceptance:remove:' + row.continuityRef,
      }, 202);
      await until(async () => {
        await tick();
        return (await controls(platform)).find(r => r.continuityRef === row.continuityRef)?.installation.state === 'decommissioned';
      }, 600000);
    }
    return (await controls(platform)).find(r => r.continuityRef === row.continuityRef);
  }

  await check(
    "a new invitation provisions a third DSP using restored host permissions",
    async () => {
      await tick();
      const row = read((db) =>
        db
          .prepare(
            "SELECT * FROM installations WHERE organization_id NOT IN (?,?)",
          )
          .get(...rows.map((r) => r.organization_id)),
      );
      assert.ok(row);
      assert.equal(row.status, "waiting_for_owner");
    },
  );
  await check(
    "permanent deletion requires removal, the administrator password and current revision",
    async () => {
      const row = (await controls(platform)).find(
        (r) => r.name === rows[0].name,
      );
      await api(
        platform,
        "/api/platform/installation/delete",
        {
          controlRef: row.controlRef,
          expectedRevision: row.installation.revision,
          idempotencyKey: "lab:acceptance:delete:bad-password",
          password: "wrong",
        },
        403,
      );
      await api(
        platform,
        "/api/platform/installation/delete",
        {
          controlRef: row.controlRef,
          expectedRevision: row.installation.revision - 1,
          idempotencyKey: "lab:acceptance:delete:stale",
          password: "disposable lab password 123",
        },
        409,
      );
    },
  );
  await check(
    "deleting a DSP erases its data, account, secrets, metadata and every containing archive",
    async () => {
      const row = await removeForDeletion((await controls(platform)).find(
        (r) => r.name === rows[0].name,
      ));
      const body = {
        controlRef: row.controlRef,
        expectedRevision: row.installation.revision,
        idempotencyKey: "lab:acceptance:delete:one",
        password: "disposable lab password 123",
      };
      await api(platform, "/api/platform/installation/delete", body, 202);
      await until(async () => {
        await tick();
        return !read((db) =>
          db
            .prepare("SELECT 1 FROM organizations WHERE id=?")
            .get(rows[0].organization_id),
        );
      }, 600000);
      assert.equal(fs.existsSync(plans[0].host.tenantRoot), false);
      assert.equal(fs.existsSync(plans[0].host.bridgeRoot), false);
      assert.equal(fs.existsSync(plans[0].host.unitPath), false);
      assert.throws(() =>
        call("/usr/bin/getent", ["passwd", plans[0].account.name]),
      );
      for (const email of ["owner0@example.test", "member0@example.test"])
        assert.equal(
          read((db) =>
            db.prepare("SELECT 1 FROM users WHERE email=?").get(email),
          ),
          undefined,
        );
      for (const r of records.filter(
        (r) => r.organization_id === rows[0].organization_id,
      ))
        for (const tier of ["all", "7", "30", "90", "365"])
          assert.equal(
            fs.existsSync(`/srv/dispatch-lab-remote/archives/${tier}/${r.id}`),
            false,
          );
      const state = JSON.parse(
        fs.readFileSync("/root/lab-recovery-state.json"),
      );
      for (const tier of ["all", "7", "30", "90", "365"])
        assert.equal(
          fs.existsSync(
            `/srv/dispatch-lab-remote/archives/${tier}/${state.row.id}`,
          ),
          false,
        );
      const peer = await login("owner1@example.test");
      await api(peer, "/api/paycom/daily?date=2026-09-05");
      assert.equal(
        fs.readFileSync(
          plans[1].host.installationRoot + "/data/lab-marker",
          "utf8",
        ),
        "tenant-1-before",
      );
    },
  );
  await check(
    "deleted DSP credentials and archive IDs cannot recreate or restore it",
    async () => {
      await api(
        null,
        "/api/auth/login",
        {
          email: "owner0@example.test",
          password: "disposable lab password 123",
        },
        401,
      );
      const record = records.find(
        (r) => r.organization_id === rows[0].organization_id,
      );
      await api(
        platform,
        "/api/platform/backups",
        {
          action: "restore",
          organizationId: rows[0].organization_id,
          backupId: record.id,
          confirmation: rows[0].name,
          idempotencyKey: "lab:acceptance:deleted:restore",
        },
        409,
      );
    },
  );
  await check(
    "all remaining test DSPs can be deleted, including an unaccepted invitation",
    async () => {
      for (const original of await controls(platform)) {
        const row = await removeForDeletion(original);
        await api(
          platform,
          "/api/platform/installation/delete",
          {
            controlRef: row.controlRef,
            expectedRevision: row.installation.revision,
            idempotencyKey: "lab:acceptance:cleanup:" + row.continuityRef,
            password: "disposable lab password 123",
          },
          202,
        );
        await until(async () => {
          await tick();
          return !(await controls(platform)).some(
            (r) => r.controlRef === row.controlRef,
          );
        }, 600000);
      }
      assert.equal(
        read(
          (db) => db.prepare("SELECT count(*) AS n FROM organizations").get().n,
        ),
        0,
      );
    },
  );
  await check("cleanup leaves no tenant identities, remote archives or host allocations", async () => {
    await until(async () => {
      if ((await require("./offsite").storage.listArchives()).length) return false;
      const { DatabaseSync } = require("node:sqlite");
      const host = JSON.parse(fs.readFileSync("/etc/dispatch/oci-host.json"));
      const db = new DatabaseSync(host.stateRoot + "/oci-host.sqlite3", { readOnly: true });
      try { return db.prepare("SELECT count(*) AS n FROM allocations").get().n === 0; }
      finally { db.close(); }
    }, 120000);
    for (const table of ["installations", "roles", "memberships"])
      assert.equal(read(db => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n), 0);
    assert.equal(read(db => db.prepare("SELECT count(*) AS n FROM invitations WHERE organization_id IS NOT NULL").get().n), 0);
    assert.equal(read(db => db.prepare("SELECT count(*) AS n FROM users").get().n), 1);
  });
  report.status = report.cases.every(c => c.status === "passed") ? "passed" : "failed";
  if (report.status !== "passed") process.exitCode = 1;
  fs.writeFileSync("/root/lab-report.json", JSON.stringify(report, null, 2));
}
main().catch((e) => {
  report.status = "failed";
  fs.writeFileSync("/root/lab-report.json", JSON.stringify(report, null, 2));
  console.error(e.stack);
  process.exitCode = 1;
});
