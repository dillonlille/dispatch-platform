# Update recovery and Cloudflare R2 backups

A rollout still updates Core first, then every DSP one at a time. A failure pauses the rollout. DSPs already verified on the new release stay there; the failed DSP returns to its prior release when recovery succeeds. Remaining DSPs stay on their working release until the owner resumes the rollout.

## Core safety

Before stopping anything, the candidate verifies the installed release, both fixed host-switch permissions, free disk space, database integrity, schema compatibility, and runtime protocol compatibility. It trials its database startup against a copy. Schema transitions must appear in the candidate’s explicitly reviewed migration list; unknown transitions fail preflight.

The updater arms an independent user-systemd recovery timer, stops reconciliation, drains any active reconciliation job, stops Core, and uses SQLite's backup API to capture a consistent database. It restores that backup to a temporary database and checks it before proceeding. In-flight snapshot attempts live separately under `LOCAL_ROOT/backups/platform-core/ROLLOUT_ID/attempt-N`.

The candidate blocks normal HTTP traffic while verification runs. An unpredictable private probe checks identity, database integrity, foreign keys, required tables, and a write/read transaction which is rolled back. Health must remain good during a 15-second observation period. Only then does Core reopen traffic and reconciliation.

The recovery journal lives outside the database being restored. Before promotion, recovery stops the candidate, restores the database in place using SQLite's backup API, restores the previous immutable host helper and service units, and verifies the prior Core. Once the old service can accept writes, replay never restores that database again. After promotion, recovery only finishes opening traffic; it never rewinds newly accepted work.

The separate recovery timer uses the updater's existing process lock. It cannot interfere with an active update, and takes over after an interrupted or timed-out updater exits. It persists a paused rollout after recovery and then disarms itself. Corrupt backups or failed recovery leave the rollout stopped for investigation; they do not authorize a destructive best-effort restore. This is recovery protection, not a zero-downtime guarantee: Core restarts and verification cause a brief maintenance interval.

For inspection or manual recovery, run as the dashboard service account from a trusted checkout containing this change:

```bash
./core/installations/bin/dispatch-core-recover status /absolute/local/root rollout_ID
./core/installations/bin/dispatch-core-recover recover /absolute/local/root rollout_ID
```

Use the actual `rollout_` plus 32 hexadecimal characters from the backup directory. The command verifies the immutable candidate artifact and shares the updater lock. Its output contains state and release identities, never passwords or the private probe token. Do not manually copy a database file over a running SQLite database or delete its WAL files.

## DSP safety

Existing lifecycle protections quiesce scheduled collection, stop the old runtime, snapshot its data/state, runtime configuration and credential-encryption material, install the pinned native package, verify infrastructure and publication data, and restore the prior code/data on failure. Human runtime requests remain unavailable while the installation is upgrading. Backups now reserve room for a full restore before copying data.

A durable compensation checkpoint is written before the restored runtime and its background work start again. Replaying an interrupted compensation skips the data restore after this checkpoint, preserving new records collected by the restored runtime. Lease fencing still applies to recovery mutations. If recovery itself fails, the DSP remains unavailable rather than being reported healthy.

## Cloudflare R2 setup

R2 is the selected off-server destination. The implementation uses restic's encrypted S3 backend. R2 credentials and the repository password are root-only and never passed into a DSP or browser. Until the destination is configured, local recovery works but off-server protection is **not active**.

Use a dedicated private R2 Standard bucket. Disable public access. Create an R2 S3 access key with object read/write permissions restricted to that bucket. The bucket-scoped S3 key is different from a Cloudflare management API token. Keep a copy of the restic password in a password manager outside this server; R2 access alone cannot decrypt a backup.

Legacy backups use **retain all backups**. Automatic retention never runs `forget` or `prune` against that shared repository. An explicitly confirmed **Delete DSP** request is the exception described below. New dashboard-managed snapshots use the independent archives described below. For protection against deletion by the backup key, configure indefinite R2 bucket locks on these prefixes (substitute the configured repository prefix):

- `dispatch/config`
- `dispatch/keys/`
- `dispatch/data/`
- `dispatch/index/`
- `dispatch/snapshots/`

Leave `dispatch/locks/` unlocked: restic must remove its temporary repository locks. Do not lock the entire bucket. Keep the original legacy locks in place. The root exporter also uses a separate R2 management token to verify and create the new archive retention rules; it preserves unrelated bucket locks. The legacy Remove operation retains backups; **Delete DSP** explicitly erases them.

On the host, install restic 0.16 or newer at `/usr/bin/restic`. Using a protected terminal, create the following root-owned files with mode `0600`. Do not put real credentials in Git, chat, command arguments, or shell history.

`/etc/dispatch/offsite-backup.json`:

```json
{
  "schemaVersion": 1,
  "accountId": "YOUR_32_CHARACTER_CLOUDFLARE_ACCOUNT_ID",
  "bucket": "dispatch-backups",
  "prefix": "dispatch",
  "localRoot": "/absolute/dispatch/local/root",
  "coreUid": 1001,
  "retention": "retain-all"
}
```

`/etc/dispatch/offsite-backup-credentials.json`:

```json
{
  "accessKeyId": "R2_S3_ACCESS_KEY_ID",
  "secretAccessKey": "R2_S3_SECRET_ACCESS_KEY"
}
```

`/etc/dispatch/offsite-backup-password`: a randomly generated password of at least 32 characters, saved separately outside this host as well. Use the actual service UID and local root from the host deployment configuration.

After a release containing this code has been prepared by release delivery, invoke its verified immutable backup entrypoint as root:

```bash
sudo /opt/dispatch-platform/releases/RELEASE_ID/core-artifact/code/core/installations/bin/dispatch-offsite-backup init
sudo /opt/dispatch-platform/releases/RELEASE_ID/core-artifact/code/core/installations/bin/dispatch-offsite-backup enable
```

`init` is only for a new repository; it does not replace an existing one. `enable` exports existing completed snapshots, proves a new canary can be encrypted, uploaded, downloaded and restored, installs a root-owned timer pinned to this immutable artifact, and only then enables the required-backup policy. It does not start a platform rollout.

The timer scans completed Core snapshots and DSP backup manifests every 15 seconds after its previous run. It copies eligible snapshots to a private staging directory, validates the manifest, encrypts/uploads, downloads/restores, and compares every restored file to the original. Only a successful restore produces a root-owned verification receipt. Each Core replacement and DSP upgrade then waits for its matching receipt. Upload/download/validation failure prevents that replacement and returns the working service through normal recovery. Native replacements require a full recovery proof and allow up to one hour for upload and restore verification. Failure leaves the update recoverable; the runtime is not replaced without the matching proof.

Status and a full read/check of repository data:

```bash
sudo /opt/dispatch-platform/releases/RELEASE_ID/core-artifact/code/core/installations/bin/dispatch-offsite-backup status
sudo /opt/dispatch-platform/releases/RELEASE_ID/core-artifact/code/core/installations/bin/dispatch-offsite-backup check
systemctl status dispatch-offsite-backup.timer dispatch-offsite-backup.service
```

Every new export includes an actual restore drill. `check` can also be run to detect later remote corruption; it does not overwrite any production data. No stale receipt is reused for a different snapshot digest.

Native recovery archives include application code, exact Node/Chrome dependencies, databases and files, configuration, encryption material, registration credentials, Linux identities, service definitions and startup settings for their scope. A dashboard Core recovery capsule contains only Core; a full-system recovery set combines it with independent DSP capsules. Internal rollout safety capsules retain their existing full-platform format. Individual DSP archives include their completed readiness and suspension evidence so subsequent lifecycle operations can verify continuity after a fresh-host restore. The dashboard’s individual restore restores data and DSP metadata into the existing compatible runtime.

This is a Dispatch application recovery system for Ubuntu 24.04 amd64, not a disk image of unrelated VPS applications. Recovery installs the required Ubuntu packages and restores Dispatch’s exact private runtime dependencies. Records created after the chosen snapshot are outside that snapshot. A compatible fresh host, sufficient disk/RAM, network access to R2/package repositories, and a separately retained recovery kit are required. Existing conflicting Dispatch paths or account IDs cause restore to stop.

### Full platform restoration

Export the private kit as root from the installed release:

```sh
sudo /opt/dispatch-platform/releases/RELEASE_ID/core-artifact/code/core/installations/bin/dispatch-recovery-kit export /absolute/new-private-kit-directory
```

Move that directory off the VPS into protected storage. It contains storage access and decryption secrets, the recovery program, Node and its dependencies, and restic. Keep the kit current when storage credentials/password change. Losing both the VPS and its only decryption key cannot be repaired by an R2 archive.

On a fresh Ubuntu 24.04 amd64 VPS, restore as root:

```sh
./restore list
./restore restore BACKUP_ID all
# For a pre-update full Core snapshot in the shared repository:
./restore restore platform-core SNAPSHOT_ID
```

Use the exact backup ID and retention tier from the list. The kit downloads and authenticates the encrypted archive, verifies the complete file inventory, installs prerequisites, recreates accounts, restores ownership/code/data/secrets, restores startup services, and verifies Core identity and the health API of each active DSP. Suspended DSPs remain disabled. Interrupted rollouts are paused so recovery does not immediately update the restored version again. A free-space check runs before accounts or installed files change. A failed host restore is not reported as successful; investigate the error on the replacement host before retrying, since partially installed files are not overwritten automatically.

Successful native rollouts prune local safety snapshots and obsolete release trees only after the fleet has settled and root confirms full recovery proofs. Remote backups remain the historical version store. Active restoration and compensation snapshots stay pinned until those operations settle.

## Verification

Tests exercise real SQLite backups/restores with an open supervisor connection, actual SIGKILL at update boundaries, failure before candidate promotion, failed off-server verification, corrupt backups, and replay after service restart. HTTP tests prove maintenance blocks both public and authenticated requests without changing sessions. DSP tests prove the recovery checkpoint is durable and fenced. A real restic repository test proves encrypted upload/download/restore, password rejection, and absence of plaintext business records in repository files. CI installs restic to run this test rather than skipping it.

Cloudflare R2 setup still requires a real bucket and credentials. Local restic tests do not substitute for the R2 canary and bucket-lock checks on the selected account.

References: [R2 S3 credentials](https://developers.cloudflare.com/r2/api/tokens/), [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [restic S3 backend](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html), [restic restore](https://restic.readthedocs.io/en/stable/050_restore.html).


## Independent Core, DSP and full-system backups

The platform owner's Backups page provides three scopes. A Core operation affects
only Core; a DSP operation affects only the selected DSP. A full-system backup
creates a separate Core archive and one independent archive for every eligible
DSP, together with an encrypted manifest referencing those archives. A full-system
restore or deletion explicitly selects that complete set. Removed DSPs remain
stopped and are excluded from new backups; their previous archives remain held.

Every DSP, Core, and the full system has its own hourly, daily, or weekly schedule,
time zone, time/day, and retention policy. Every new schedule starts disabled,
including when upgrading from the old shared policy. Only the platform owner can
change schedules. Enabling the full-system schedule does not enable individual
schedules. Each full-system run uses its own retention policy for its components.

Core archives contain platform-owner accounts, Core's schedule, platform
configuration, and platform credentials. The copied Access Control database is
scrubbed and vacuumed before export: DSP users, memberships, organization data,
installation coordination, DSP schedules, runtime registration credentials, and
backup catalogs are excluded. Core recovery capsules exclude DSP runtime roots,
DSP services, and the tenant provisioner database. Core-only restore preserves
live DSP records and DSP/full-system schedules, revokes platform-owner sessions,
creates a verified safety backup, applies Core settings, restarts only the dashboard,
and checks Core health. Failed verification attempts recovery from the safety copy.
Current account passwords and disablement are preserved during in-place restores.

DSP snapshots contain runtime data, state, configuration, auth-broker secrets,
organization details, roles, permissions, users, and that DSP's individual
schedule. Private host identity metadata supports full-system disaster recovery.
In-place DSP restores preserve host identities, registration credentials and the
current runtime release; they use the existing fenced stop, safety-backup,
restore, verification and recovery sequence. They do not revive old invitations
or sessions or grant platform roles.

Full-system sets remain incomplete until every component and their encrypted
manifest verify. A busy/unavailable DSP prevents a new full-system set from being
queued rather than being silently skipped. In-place full-system restore requires
the same DSP inventory, validates all selected archives before queuing any work,
restores Core first, and stops subsequent components after a failure. Progress
remains visible per component. The full-system schedule is restored only after
all components succeed. A partial restore is never reported as complete.

### Independent archive retention and deletion

The **Storage** tab shows measured encrypted R2 bytes for Core, each DSP, and
removed DSPs' retained archives, with a measurement timestamp. The overall total
counts each archive once. Full-system set totals include their component archives
and manifest; those totals are not added a second time. Shared repository/rollout
safety storage, manifests, and unassigned archive objects are shown separately.
Local working copies are outside these R2 totals. Expired or deleting archives
continue to consume storage until their objects are actually removed.

The root exporter uses read-only, paginated [S3 object-size listings](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).
Measurements refresh after archive changes and approximately every five minutes;
they include archives beyond the dashboard's recent-history limit. Failed scans
show the last measurement as stale, or unavailable when there is no measurement.
Usage failures do not block backup or recovery operations.

Each component snapshot has its own encrypted restic repository at
`archives/TIER/BACKUP_ID/`. Tiers are `all`, `7`, `30`, `90`, or `365` days.
Full-system manifests live separately at `sets/SET_ID/`; they contain archive
references and the full-system schedule, not duplicate DSP data. Every upload is
verified by downloading it and checking integrity before being shown as ready.

Deleting a Core or DSP backup removes only that selected archive. Deleting a
full-system set deletes all of its component archives and its manifest, with
completion withheld until storage confirms removal. Deleting an individual
component makes a set referencing it incomplete; other component archives remain
independently usable. No archive-deletion action deletes live Core or DSP data.
Storage failures remain visible and retryable. Automatic retention cannot expire
archives held for removed DSPs or active restores.

Root serializes storage mutations under the exporter lock. Explicit archive
deletion temporarily lifts only the configured archive-tier retention locks and
restores them from a durable journal. Broader administrator locks block deletion.
The storage credential and lock-management token never enter the dashboard.

### Recovery on a replacement host

Export and store the private recovery kit outside the VPS. On a clean Ubuntu
24.04 amd64 replacement host, run `./restore list`, then
`./restore restore-system SET_ID`. The kit downloads and authenticates all
components, assembles their scoped metadata into a verified recovery capsule,
and only then installs accounts, code, secrets, services, and data. A missing or
corrupt component aborts before installed host paths change. Existing Dispatch
installations are never overwritten by the replacement-host command.

`./restore restore CORE_BACKUP_ID TIER` recovers only Core on a clean host.
Legacy full-platform safety snapshots retain their separate recovery command;
ordinary Core/DSP archives are not mixed with those internal rollout checkpoints.

### Activation and inspection

When a verified Core release switches the host helpers and an offsite configuration exists, it also starts an independent `dispatch-backup-enable-RELEASE_ID.service`. That service performs the encryption/restore canary and enables the root export timer and mandatory offsite policy. This occurs within the normal Core-first rollout; a merge does not modify the live dashboard. Initial setup requires the root-only storage credentials/password. An empty legacy repository is initialized during enable. Automatic scheduling is configured on the Backups page after the service is connected.

`dispatch-offsite-backup check` checks both the legacy repository and all non-expired independent archives. A backup operation that cannot obtain verification or download within one hour fails visibly. A native restore safety upload requires a full recovery proof with a one-hour lease-renewing deadline. Inspect the backup worker and reconciler journals for a failed operation; do not delete a safety snapshot or manually reopen a failed DSP to bypass recovery.

### Permanent DSP deletion

Active DSPs expose Remove DSP. Removal stops services and backup creation,
revokes DSP sessions, blocks login, and retains data and existing backups.
Removed DSPs expose Restore DSP and Permanently delete DSP after shutdown
completes. Permanent deletion requires the acting platform owner's password.
The worker removes the DSP's services, verifies remote archive erasure, and then
removes local data, backup files, host account, and scoped Core metadata. Failed
deletion remains visible and retryable. Newly isolated Core backups and other
DSPs' archives survive DSP deletion; historical mixed safety snapshots are
handled conservatively as described below.

Under the root exporter's existing flock, explicit deletion purges every known DSP backup ID in every independent archive tier, including incomplete uploads and expired records. Legacy snapshots are selected by their server-derived source tags, forgotten, and pruned with `--max-unused 0` from the shared encrypted repository, so unused target data is not left in mixed packs. Remaining snapshot IDs are compared before/after and restic checks the remaining repository data. Core/full-platform snapshots containing the DSP are erased. Root-verified complete organization inventories preserve unrelated snapshots, including those made before the DSP existed. Older incomplete inventories cannot prove absence and remain subject to erasure. Other DSPs’ individual snapshots are preserved. No new backup is exported for a DSP whose current lifecycle job is destruction.

Deletion temporarily lifts the exact configured archive-tier and legacy data/index/snapshot locks needed by that request. This makes those shared prefixes writable during the serialized purge; automatic retention remains unchanged. The config/key locks and unrelated administrator locks are preserved, and broader locks block deletion. Removed rules are saved to a root-only journal before changing R2, restored in `finally`, and restored before any subsequent scan after interruption. A failed restoration leaves the journal in place and blocks success. Do not run another storage writer or change these rules outside the serialized root worker during a purge.

Only after R2 objects are absent, legacy pruning/checks finish, and lock restoration succeeds does root publish an opaque receipt bound to the lifecycle job, DSP, and runtime key. The lifecycle worker requires that receipt whenever offsite protection is enabled. A one-hour receipt timeout or storage failure keeps the deletion incomplete; a retry is idempotent. The dashboard backup catalog is marked deleted only after local destruction also verifies.

Full-host capture supports the current Ubuntu 26.04 VPS and Ubuntu 24.04. The verified replacement-host target is Ubuntu 24.04 amd64. The capsule carries private Node libraries, including its loader and libc, to preserve the captured application runtime across those host versions.
