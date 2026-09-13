"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createRestic } = require("../../src/offsite-backup");
const { createBackupArchives } = require("../../src/backup-archives");
const { atomic } = require("../../src/release-delivery-files");
const { RECEIPTS } = require("../../src/offsite-policy");
const root = "/srv/dispatch-lab-remote",
  localRoot = "/home/dispatchlab/local";
const config = {
  localRoot,
  coreUid: 1001,
  accountId: "a".repeat(32),
  bucket: "dispatch-lab",
  prefix: "dispatch",
  environment: {
    PATH: "/usr/bin:/bin",
    RESTIC_PASSWORD_FILE: "/etc/dispatch/offsite-backup-password",
    RESTIC_REPOSITORY: "s3:https://fixture/dispatch-lab/dispatch",
  },
};
function repository(env) {
  const relative = env.RESTIC_REPOSITORY.split("/dispatch-lab/")[1];
  if (
    !/^(dispatch|archives\/(all|7|30|90|365)\/(breq|backup)_[a-f0-9]{32})$/.test(
      relative,
    )
  )
    throw Error("unsafe_test_repository");
  return path.join(root, relative);
}
function runFactory(env) {
  const repo = repository(env),
    run = createRestic({ ...env, RESTIC_REPOSITORY: repo });
  if (!fs.existsSync(repo + "/config")) {
    fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
    run(["init"]);
  }
  return run;
}
const storage = {
  listArchives: async () =>
    [null, 7, 30, 90, 365].flatMap((retentionDays) => {
      const dir =
        root + "/archives/" + (retentionDays === null ? "all" : retentionDays);
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((id) => fs.existsSync(dir + "/" + id + "/config"))
            .map((id) => ({ id, retentionDays }))
        : [];
    }),
  ensureLocks: async () => {},
  withDeletionAccess: async (prefixes, action) => action(),
  removePermanent: async ({ id, retentionDays }) => {
    if (!/^(breq|backup)_[a-f0-9]{32}$/.test(id))
      throw Error("bad_test_archive");
    fs.rmSync(
      `${root}/archives/${retentionDays === null ? "all" : retentionDays}/${id}`,
      { recursive: true, force: true },
    );
  },
  removeExpired: async (row) => storage.removePermanent(row),
};
async function main() {
  if (os.hostname() !== "dispatch-dsp-lab" || process.geteuid() !== 0)
    throw Error("disposable_vm_required");
  process.umask(0o077);
  // This fixture runs one serialized worker process, like the locked production job.
  require("../../src/backup-scratch").cleanupBackupScratch("/var/lib/dispatch-backup");
  require("../../src/backup-scratch").cleanupRestoreStaging();
  const archives = createBackupArchives(config, { runFactory, storage });
  for (;;) {
    try {
      const result = await archives.scan();
      atomic(
        RECEIPTS + "/status.json",
        {
          schemaVersion: 1,
          status: result.failed ? "attention" : "verified",
          checkedAt: Date.now(),
        },
        0o644,
      );
      fs.chmodSync(RECEIPTS + "/status.json", 0o644);
      if (result.failed) console.log(JSON.stringify(result));
      try {
        require("../../src/retired-dsp-metadata").purgeRetiredMetadata(config);
      } catch (e) {
        console.error("retired_metadata:" + e.message);
      }
    } catch (e) {
      console.error(e.stack);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  });
module.exports = { config, runFactory, storage };
