"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { atomic } = require("./release-delivery-files");
const { publicRootJson } = require("./offsite-policy");
const empty = () => ({ bytes: 0, backupCount: 0 });
function summarize(inventory, records, sets) {
  const core = empty(),
    other = empty(),
    dsps = new Map();
  const byId = new Map(records.map((row) => [row.id, row]));
  const add = (a, b) => {
    if (!Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(a + b))
      throw Error("backup_usage_invalid");
    return a + b;
  };
  let bytes = 0;
  for (const [id, size] of Object.entries(inventory.archives)) {
    const row = byId.get(id);
    let scope = other;
    if (row?.kind === "core") scope = core;
    else if (row?.organization_id) {
      if (!dsps.has(row.organization_id))
        dsps.set(row.organization_id, {
          organizationId: row.organization_id,
          ...empty(),
        });
      scope = dsps.get(row.organization_id);
    }
    scope.bytes = add(scope.bytes, size);
    scope.backupCount++;
    bytes = add(bytes, size);
  }
  let manifestBytes = 0;
  for (const size of Object.values(inventory.sets))
    manifestBytes = add(manifestBytes, size);
  bytes = add(add(add(bytes, manifestBytes), inventory.legacyBytes), inventory.artifactBytes || 0);
  return {
    bytes,
    backupCount: Object.keys(inventory.archives).length,
    core,
    dsps: [...dsps.values()],
    other,
    manifestBytes,
    legacyBytes: inventory.legacyBytes,
    artifactBytes: inventory.artifactBytes || 0,
    sets: sets.map((set) => {
      const ids = new Set(
        JSON.parse(set.members_json)
          .map((m) => m.backupId)
          .filter(Boolean),
      );
      let componentBytes = 0,
        backupCount = 0;
      for (const id of ids)
        if (Object.hasOwn(inventory.archives, id)) {
          componentBytes = add(componentBytes, inventory.archives[id]);
          backupCount++;
        }
      const manifestBytes = inventory.sets[set.id] || 0;
      return {
        id: set.id,
        bytes: add(componentBytes, manifestBytes),
        backupCount,
        manifestBytes,
      };
    }),
  };
}
async function measureStorageUsage({
  storage,
  config,
  workRoot,
  ownerUid,
  records,
  sets,
  version,
  clock = Date.now,
}) {
  const file = path.join(workRoot, "storage-usage.json");
  const storageKey = crypto
    .createHash("sha256")
    .update(JSON.stringify([config.accountId, config.bucket, config.prefix]))
    .digest("hex");
  const signature = crypto
    .createHash("sha256")
    .update(JSON.stringify([storageKey, version]))
    .digest("hex");
  let cached;
  try {
    if (fs.existsSync(file))
      cached = publicRootJson(file, false, ownerUid, 16 * 1024 * 1024);
  } catch {}
  if (
    cached?.storageKey !== storageKey ||
    !Number.isSafeInteger(cached?.checkedAt)
  )
    cached = null;
  try {
    if (
      !cached ||
      cached.signature !== signature ||
      clock() - cached.checkedAt >= 300000 ||
      clock() < cached.checkedAt
    ) {
      const inventory = await storage.usage();
      // Validate the complete inventory before publishing or caching any totals.
      summarize(inventory, records, sets);
      cached = { storageKey, signature, checkedAt: clock(), inventory };
      atomic(file, cached);
    }
    return {
      ...summarize(cached.inventory, records, sets),
      status: "ready",
      checkedAt: cached.checkedAt,
    };
  } catch {
    // Usage reporting cannot block a backup or turn a failed measurement into 0 B.
    if (cached)
      try {
        return {
          ...summarize(cached.inventory, records, sets),
          status: "stale",
          checkedAt: cached.checkedAt,
        };
      } catch {}
    return { status: "unavailable", checkedAt: null };
  }
}
module.exports = { summarize, measureStorageUsage };
