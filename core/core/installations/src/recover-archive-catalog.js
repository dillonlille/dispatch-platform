"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { tree, verifySnapshot } = require("./offsite-backup");
const { recoveryRoots } = require("./host-recovery-bundle");
const capsule = require("./recovery-capsule");
const hash = (value) =>
  require("node:crypto").createHash("sha256").update(value).digest("hex");
// A restored database predates its own archive and may predate newer backups.
// Rediscover those encrypted repositories before permitting further deletion.
async function recoverArchiveCatalog({
  config,
  storage,
  runFor,
  workRoot,
  ownerUid,
  record,
  save,
  clock,
}) {
  const marker = path.join(workRoot, "rediscover.json");
  if (!fs.existsSync(marker)) return;
  const rows = await storage.listArchives();
  for (const row of rows) {
    if (
      !/^(backup|breq)_[a-f0-9]{32}$/.test(row.id) ||
      ![null, 7, 30, 90, 365].includes(row.retentionDays)
    )
      throw Error("backup_catalog_invalid");
    if (record(row.id)) continue;
    const work = fs.mkdtempSync(path.join(workRoot, "rediscover-"));
    try {
      const run = runFor(row.id, row.retentionDays),
        snapshots = run(["snapshots"]).flat();
      if (snapshots.length !== 1 || !/^[a-f0-9]{64}$/.test(snapshots[0].id))
        throw Error("backup_catalog_invalid");
      run(["restore", snapshots[0].id, "--target", work, "--verify"]);
      const bundle = path.join(work, "bundle"),
        info = JSON.parse(fs.readFileSync(path.join(bundle, "dsp.json")));
      if (
        info.schemaVersion !== 1 ||
        info.id !== row.id ||
        !["core", "dsp"].includes(info.kind) ||
        info.retentionDays !== row.retentionDays
      )
        throw Error("backup_catalog_invalid");
      const checked = verifySnapshot(path.join(bundle, "snapshot"), ownerUid),
        total = tree(bundle, ownerUid);
      const proof = JSON.parse(
          fs.readFileSync(path.join(bundle, "recovery-proof.json")),
        ),
        manifest = JSON.parse(
          fs.readFileSync(path.join(bundle, "recovery/recovery.json")),
        );
      require('./recovery-artifacts').hydrate(path.join(bundle, 'recovery'), proof.sha256,
        require('./recovery-artifacts').resticReader(config));
      capsule.verify(
        path.join(bundle, "recovery"),
        proof.sha256,
        recoveryRoots(manifest.metadata, manifest.roots),
      );
      const organizationId =
        info.kind === "core" ? null : info.metadata.organizationId;
      if (
        organizationId !== null &&
        !/^[a-z][a-z0-9_-]{2,95}$/.test(organizationId)
      )
        throw Error("backup_catalog_invalid");
      const createdAt = Date.parse(snapshots[0].time);
      if (!Number.isSafeInteger(createdAt))
        throw Error("backup_catalog_invalid");
      const snapshot = JSON.parse(
        fs.readFileSync(path.join(bundle, "snapshot/manifest.json")),
      );
      const metadataJson = JSON.stringify(info.metadata);
      const db = new DatabaseSync(
        path.join(
          config.localRoot,
          "data/access-control/access-control.sqlite3",
        ),
      );
      try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
        if (
          organizationId === null ||
          db
            .prepare("SELECT 1 FROM organizations WHERE id=?")
            .get(organizationId)
        )
          db.prepare(
            "INSERT OR IGNORE INTO platform_backup_records VALUES(?,?,?,?,?,?,?,NULL)",
          ).run(
            row.id,
            organizationId,
            info.kind,
            metadataJson,
            row.retentionDays,
            createdAt,
            row.retentionDays === null
              ? null
              : createdAt + row.retentionDays * 86400000,
          );
      } finally {
        db.close();
      }
      save(row.id, {
        schemaVersion: 1,
        id: row.id,
        organizationId,
        kind: info.kind,
        status: "verified",
        metadataDigest: hash(metadataJson),
        metadataJson,
        digest: checked.digest,
        bundleDigest: total.digest,
        snapshotId: snapshots[0].id,
        size: total.size,
        retentionDays: row.retentionDays,
        verifiedAt: clock(),
        expiresAt:
          row.retentionDays === null
            ? null
            : createdAt + row.retentionDays * 86400000,
        format: snapshot.version,
        trigger: snapshot.purpose || "scheduled",
        deletedAt: null,
        recoveryDigest: proof.sha256,
        recoveryArtifacts: [...new Map(manifest.entries.filter(entry => entry.artifact).map(entry => [entry.artifact.digest, entry.artifact])).values()],
        organizationIds: proof.organizationIds,
      });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  fs.unlinkSync(marker);
}
module.exports = { recoverArchiveCatalog };
