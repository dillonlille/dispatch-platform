"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const execute = require("node:util").promisify(execFile);
const { DatabaseSync } = require("node:sqlite");
const LOCAL = "/home/dispatchlab/local",
  BASE = "http://127.0.0.1:4310";
const report = {
  schemaVersion: 1,
  status: "running",
  cases: [],
  boundaries: {
    providers:
      "synthetic publication fixtures; live provider authentication not exercised",
    email: "private file inbox",
    offsite:
      "real encrypted Restic with isolated local repository; R2 transport covered separately",
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, action) {
  const started = Date.now();
  try {
    await action();
    report.cases.push({
      name,
      status: "passed",
      durationMs: Date.now() - started,
    });
    console.log("PASS " + name);
  } catch (e) {
    report.cases.push({ name, status: "failed", error: e.message });
    throw e;
  } finally {
    fs.writeFileSync("/root/lab-report.json", JSON.stringify(report, null, 2));
  }
}
async function api(session, endpoint, body, status = 200) {
  const response = await fetch(BASE + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(session?.cookie ? { Cookie: session.cookie } : {}),
      ...(body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Dispatch-CSRF": session?.csrf || "",
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return { value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function login(email) {
  const { value, cookie } = await api(null, "/api/auth/login", {
    email,
    password: "disposable lab password 123",
  });
  return { cookie, csrf: value.data.csrfToken };
}
async function tick() {
  await execute(
    "/usr/sbin/runuser",
    [
      "--user",
      "dispatchlab",
      "--",
      "/usr/bin/env",
      "XDG_RUNTIME_DIR=/run/user/1001",
      "/usr/bin/systemctl",
      "--user",
      "start",
      "dispatch-installation-reconcile.service",
    ],
    { timeout: 600000 },
  );
}
const read = (fn) => {
  const db = new DatabaseSync(
    LOCAL + "/data/access-control/access-control.sqlite3",
    { readOnly: true },
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(500);
  }
  throw Error("condition_timeout");
}
async function main() {
  assert.equal(os.hostname(), "dispatch-dsp-lab");
  assert.equal(process.geteuid(), 0);
  await until(async () => {
    try {
      return (await fetch(BASE + "/api/auth/session")).status < 500;
    } catch {
      return false;
    }
  });
  const platform = await login("platform@example.test");
  const owners = [];
  await check(
    "dashboard invitation creates exactly one queued native DSP",
    async () => {
      for (let i = 0; i < 2; i++) {
        const body = {
          ownerEmail: `owner${i}@example.test`,
          idempotencyKey: `lab:acceptance:create:owner:${i}`,
        };
        await api(platform, "/api/platform/organizations", body, 201);
        await api(platform, "/api/platform/organizations", body, 200);
        const messages = fs
          .readFileSync(LOCAL + "/inbox.jsonl", "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        const message = messages.find(
          (m) =>
            m.email === body.ownerEmail ||
            m.recipientEmail === body.ownerEmail ||
            m.ownerEmail === body.ownerEmail,
        );
        assert.ok(message, JSON.stringify(messages));
        const { value, cookie } = await api(
          null,
          "/api/auth/register",
          {
            token: message.token,
            firstName: "Lab",
            lastName: `Owner${i}`,
            password: "disposable lab password 123",
            confirmPassword: "disposable lab password 123",
          },
          201,
        );
        owners.push({
          cookie,
          csrf: value.data.csrfToken,
          email: body.ownerEmail,
        });
      }
      assert.equal(
        read(
          (db) => db.prepare("SELECT count(*) AS n FROM organizations").get().n,
        ),
        2,
      );
      assert.equal(
        read(
          (db) =>
            db
              .prepare(
                "SELECT count(*) AS n FROM installations WHERE backend='native_service_v1'",
              )
              .get().n,
        ),
        2,
      );
    },
  );
  await check(
    "real reconciler provisions native accounts and healthy services",
    async () => {
      await tick();
      const rows = read((db) =>
        db.prepare("SELECT * FROM installations").all(),
      );
      assert.ok(
        rows.every((r) =>
          ["waiting_for_owner", "waiting_for_provider_auth"].includes(r.status),
        ),
        JSON.stringify(rows),
      );
    },
  );
  await check("owners complete DSP details through dashboard API", async () => {
    for (let i = 0; i < owners.length; i++)
      await api(owners[i], "/api/organization/profile", {
        name: `Lab DSP ${i}`,
        abbreviation: `L${i}`,
        stationCode: "DXX1",
        timezone: "UTC",
      });
    await tick();
    for (const owner of owners) {
      const r = await api(owner, "/api/organization/profile");
      assert.equal(r.value.data.status, "complete");
      const setup = await api(owner, "/api/organization/setup");
      assert.equal(setup.value.data.installationState, "ready");
      assert.equal(setup.value.data.operationalAccess, "available");
    }
  });
  await require("./exercise").exercise({ platform, owners });
  await require("./recovery").disaster({
    platform,
    ...JSON.parse(fs.readFileSync("/root/lab-state.json")),
  });
  fs.writeFileSync(
    "/root/lab-boot-id",
    fs.readFileSync("/proc/sys/kernel/random/boot_id"),
  );
  report.status = "awaiting_reboot";
  fs.writeFileSync("/root/lab-report.json", JSON.stringify(report, null, 2));
}
if (require.main === module)
  main().catch((e) => {
    report.status = "failed";
    fs.writeFileSync("/root/lab-report.json", JSON.stringify(report, null, 2));
    console.error(e.stack);
    process.exitCode = 1;
  });
module.exports = { api, login, tick, read, until, check, report };
