"use strict";
// Explicit live transport check. Uses synthetic data and refuses a bucket with
// existing managed archives. Never reads a DSP or Core application database.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig } = require("../../src/offsite-backup");
const { createR2BackupStorage } = require("../../src/r2-backup-storage");
const { createBackupArchives } = require("../../src/backup-archives");
const { atomic, hashFileSync } = require("../../src/release-delivery-files");
async function main() {
  assert.equal(process.geteuid(), 0);
  assert.deepEqual(process.argv.slice(2), ["--empty-bucket"]);
  process.umask(0o077);
  const config = loadConfig(),
    root = fs.mkdtempSync("/var/tmp/dispatch-r2-lab-");
  const storage = createR2BackupStorage(config, {
    journalFile: path.join(root, "deletion-locks.json"),
  });
  const id = "breq_" + crypto.randomBytes(16).toString("hex");
  let touched = false,
    cleaned = false;
  try {
    assert.equal(
      (await storage.listArchives()).length,
      0,
      "Live canary requires no existing managed archives",
    );
    const source = path.join(root, "source"),
      workRoot = path.join(root, "work"),
      receiptRoot = path.join(root, "receipts");
    for (const p of [source, workRoot, receiptRoot])
      fs.mkdirSync(p, { mode: 0o700 });
    const file = path.join(source, "access-control-before.sqlite3"),
      db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES('Dispatch disposable R2 acceptance data')",
    );
    db.close();
    fs.chmodSync(file, 0o600);
    atomic(path.join(source, "manifest.json"), {
      version: 1,
      kind: "core",
      sha256: hashFileSync(file),
      size: fs.statSync(file).size,
    });
    const archives = createBackupArchives(config, {
      storage,
      workRoot,
      receiptRoot,
      pathResolver: () => ({ source, uid: 0 }),
      recoveryCapture: ({ destination }) => ({
        organizationIds: [],
        ...require("../../src/recovery-capsule").capture(
          destination,
          [{ source, target: "/home/fixture/local/data" }],
          {
            kind: "core",
            platform: "ubuntu-24.04-amd64",
            localRoot: "/home/fixture/local",
            accounts: [
              { name: "fixture", uid: 1001, gid: 1001, home: "/home/fixture" },
            ],
            services: [],
            installations: [],
          },
          new Set([0]),
        ),
      }),
    });
    await storage.ensureLocks();
    touched = true;
    const receipt = await archives.exportRecord({
      id,
      kind: "core",
      organization_id: null,
      metadata_json: JSON.stringify({ name: "Disposable R2 acceptance" }),
      retention_days: null,
      created_at: Date.now(),
    });
    assert.equal(receipt.status, "verified");
    assert.match(receipt.recoveryDigest, /^[a-f0-9]{64}$/);
    assert.ok((await storage.listArchives()).some((row) => row.id === id));
    await storage.withDeletionAccess(["archives/all/"], () =>
      storage.removePermanent({ id, retentionDays: null }),
    );
    await storage.ensureLocks();
    assert.equal((await storage.listArchives()).length, 0);
    cleaned = true;
    console.log(
      JSON.stringify({
        status: "passed",
        encryptedUpload: true,
        independentRestoreVerified: true,
        recoveryCapsuleVerified: true,
        archiveDeleted: true,
        retentionLocksRestored: true,
      }),
    );
  } finally {
    if (touched && !cleaned) {
      await storage.withDeletionAccess(["archives/all/"], () =>
        storage.removePermanent({ id, retentionDays: null }),
      );
      await storage.ensureLocks();
      assert.ok(!(await storage.listArchives()).some((row) => row.id === id));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({ status: "failed", code: error.code || error.message }),
  );
  process.exitCode = 1;
});
