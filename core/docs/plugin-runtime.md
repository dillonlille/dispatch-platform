# Installed plugin runtime

The supported directory runtime uses one supervised Core control service,
DSP-owned installed packages, and disposable workers. The dashboard starts or
reconnects the service through `host/services/plugin-backend.js`. The service
lives in `core/auth-broker/server.js`; browser admission lives in
`core/browser-manager/`, plugin authority and SDK handlers in `core/plugins/`,
and namespace/service/storage operations in `host/`.

## Ownership and paths

| Location | Contents |
| --- | --- |
| `local/packages/plugins/<plugin>/<version>/` | Reviewed distribution packages |
| `local/config/plugin-packages.json` | Approved versions and SHA-256 digests |
| `local/state/access-control/access-control.sqlite3` | DSP membership and desired/applied plugin registry |
| `local/state/plugin-backend/` | Browser leases and durable worker identities, without vault data |
| `local/run/plugin-backend/control.sock` | Trusted Core control transport |
| `dsps/<dsp>/plugins/<plugin>/versions/<version>/` | Actual copied executable package, frontend and SDK dependency |
| `dsps/<dsp>/config/plugins/` | Selected package receipts, revision journals and explicit connection grants |
| `dsps/<dsp>/config/plugins/<plugin>/settings.sqlite3` | DSP settings, schema/revision history and idempotency receipts |
| `dsps/<dsp>/data/db/<plugin>/` | Plugin business database |
| `dsps/<dsp>/data/files/<plugin>/` | Plugin retained files |
| `dsps/<dsp>/state/plugins/<plugin>/` | Plugin state and bounded structured SDK events |
| `dsps/<dsp>/staging/plugins/<plugin>/` | Temporary collection data |
| `dsps/<dsp>/data/published/plugins/<plugin>/` | Plugin-owned indexed published projections |
| `dsps/<dsp>/data/auth-broker/` | Existing encrypted credential vault |
| `dsps/<dsp>/secrets/auth-broker/` | Existing DSP vault key |
| `dsps/<dsp>/state/auth-broker/`, `browser/` | Existing auth guards and saved browser state |
| `dsps/<dsp>/backups/plugin-revisions/` | Fenced pre-initialization state snapshots |
| `dsps/<dsp>/run/plugin-workers/` | Ephemeral job DTOs, results and scoped SDK sockets |
| `dsps/<dsp>/.control/backend.sock` | SDK framework bridge bound to that DSP |

Package bytes use separate DSP files and read-only worker mounts. Plugins are
included in version-two DSP quota volumes and offline backups. Credentials and
business data never live inside an executable package.

## Runtime contracts

The public `sdk/` package has no platform source dependency. Its Node client
provides scoped connections, jobs, schedules, actions, published reads, storage,
capabilities and structured progress/log events. Backend entrypoints receive
`dispatch`; they do not supply their DSP identity. The transport checks current
Core permissions, acknowledged version/revision, manifest declarations and
connection grants before and after operations. Worker results are also checked
against current installation authority before being returned.

`dispatch-sdk/runtime` is the trusted DSP framework's bridge. It has auth
administration and plugin execution operations, but ordinary plugin namespaces
do not mount its socket. Legacy `runtime/sdk/` clients adapt to this bridge in
the directory runtime. Existing native/artifact compatibility consumers retain
their old paths until their separate deployment migration.

Collectors use the existing collection queue, dependency graph, retries,
receipts and schedules. No second collection queue is introduced. Long collection
calls retain their existing deadlines up to one hour. Core admits at most eight
ordinary workers, two per DSP, with a bounded queue; writes serialize per plugin.
Nested SDK actions use only spare capacity and fail retryably if no slot exists.
Published reads run in workers with only the plugin's read-only published data,
without waking the DSP supervisor or exposing its source business database.
Paycom rebuilds retained publications into this read model before acknowledging
migration. Published SQLite files support fully read-only mounts without writable
WAL sidecars.

The browser manager admits two auth workers globally, one per DSP, reserving six
page tabs each. Native Chrome stays in a separate DSP auth namespace. Plugin
collection requests receive at most five concurrent tabs so the authenticated
handoff page fits inside that six-page reservation. Collection admission goes
directly to Core; installed workers do not wait on the legacy capacity socket.
Plugin browser access uses a private job relay. Cancellation, disable and lease loss
close relays and reap workers; capacity is released only after cgroup shutdown.
Core restart reaps durable orphan identities before accepting new work. Each
ordinary worker is capped at one CPU, 512 MiB and 64 tasks; each auth worker at
one CPU, 2 GiB and 512 tasks. These are resource limits, not measured fleet capacity.

## Package delivery and automatic updates

Build from a verified source checkout, choosing a new immutable plugin version
for changed release bytes:

```sh
node tooling/build-installed-plugin.mjs paycom /private/build/paycom-package
node tooling/distribute-plugin-package.js /private/platform/config/platform.json /private/build/paycom-package REVIEWED_SHA256
```

The first command returns the digest. The second takes the reviewed digest as an
explicit argument, verifies inventory, copies into private distribution storage
and updates the catalog atomically. A different digest for an already catalogued
version is rejected. Old packages remain available for recovery. Core selects the
highest approved numeric package version and automatically reconciles every
installed DSP copy. Owners select Install, Enable, Disable or Uninstall; they do
not choose versions or click Update. Uninstalled plugins stay uninstalled.
Disabled plugins receive updated code while remaining disabled. Suspended or
busy DSPs catch up when their lifecycle permits reconciliation; publishing a
package does not start or unsuspend a DSP.

Install/upgrade drains plugin workers and the supervisor while preserving auth
storage. A state snapshot precedes the isolated initializer. Core acknowledges
only after package readiness, receipt, connection grants and collection state
agree. Initializer failure restores that snapshot before releasing the fence;
acknowledgement failure resumes its journal. Existing Core enrollment with no
installed receipt is assigned a new migration revision and reconciled from its
approved version, then catches up to the latest package. Explicit uninstalls remain uninstalled. Missing or
changed distribution bytes fail closed and remain retryable.

Selecting an update advances Core's desired revision and fences further plugin
execution until acknowledgment. Reconciliation retries failed copies and processes
bounded batches. Already-running jobs are drained before replacement. This is
automatic eventual delivery, not an instantaneous fleet-wide switch. Core does
not expose a DSP pinning or rollback-version control.

Settings initialization and schema migration run inside the same fenced install
sequence. The pre-initialization snapshot includes the DSP settings directory.
Settings use the SDK's reusable declaration, store and owner API; Core contains
no Paycom field names. Paycom reads department selections from its job's bound
settings snapshot and filters published Timecards before pagination and summary
calculation. The employee directory and complete collected roster remain intact.
An empty selection shows no Timecards; the initial null selection preserves
existing coverage. Display preferences do not authorize or restrict access to
individual employee records.

## Development acceptance and production cutover

Use disposable synthetic platforms for acceptance. The architecture tests cover
real systemd namespaces, native Chrome through the SDK, separate DSP code copies,
quota-volume migration, the actual supervised daemon, the default DSP supervisor,
controller and daemon restart, cancellation, owner Install and code/data restore.
They require explicitly selected test Node/tini and sealed browser bundles;
`plugin-volume.acceptance.js` additionally requires `DISPATCH_VOLUME_TEST=1`.
They do not touch existing deployments or sign in to real provider accounts.

A production cutover is a separate operator action:

1. Verify the source build, package digest, SDK package, targeted Node tests,
   browser tests and synthetic daemon/worker acceptance. Retain the previous
   release source and dependency bundles. Review any independently reproduced
   repository baseline failures before release approval.
2. Suspend the selected DSPs through the existing owner lifecycle, confirm their
   service cgroups are stopped, and stop the dashboard/controller. Retain a
   verified offline platform backup with the currently deployed backup command.
   Preserve its backup implementation alongside that release. Never copy live
   SQLite files or browser profiles while their owners are running.
3. Stop the Core plugin backend as well when upgrading an existing new-model
   installation. Its service name is `dispatch-backend-<first 24 hex characters
   of SHA256(platformRoot)>.service`. Confirm its worker cgroups are gone before
   replacing source or browser/Node dependencies. A controller restart alone does
   not replace an already running Core daemon.
4. Install the verified release using the deployment's source replacement step;
   deliver every retained plugin version needed for recovery, then the
   new reviewed package. Keep old executable versions and all DSP state. The
   stopped version-one quota-volume migration adds the plugin bind without
   replacing existing data; nonempty unmounted plugin directories are rejected
   for explicit operator reconciliation.
5. Start the dashboard/controller with the same private platform configuration.
   Resume one suspended DSP through owner lifecycle. Verify its Core plugin
   revision is acknowledged, installed digest matches the approved version,
   retained publications load, owner/support Connections work, and browser/job
   cleanup completes. Verify provider login and a collection with that DSP's
   owner during the controlled production check. Continue with remaining DSPs
   only after that check succeeds.

## Backup and rollback

`dispatch-local-backup --help` describes the existing owner-authenticated offline
backup/restore CLI. Credentials are provided through standard input, never in
command arguments. Suspend affected DSPs and stop the dashboard first. The backup
command asks the Core backend to revoke DSP work and confirms stopped service
PIDs before taking snapshots. If a configured backend is unreachable, backup fails
closed rather than assuming its workers have stopped.

Version-two backups include actual plugin packages and their Core version/state
metadata. A single-DSP restore keeps siblings untouched, restores its code and
private state, then rebases package receipts, grants, collection state and Core
registry to a fresh monotonic revision. Its restore marker retains that revision
plan so interruption resumes the same operation. Full-platform restore restores
the matching Core database. Restores invalidate existing sessions through the
existing platform backup machinery.

A legacy version-one single-DSP backup has no plugin version metadata. When Core
has plugin rows, restore rejects it with
`directory_backup_plugin_migration_required`; restore it with the retained prior
release before migrating forward. Do not guess the old plugin version from a
newer Core row. A full source rollback similarly uses the previous release and
its matching verified platform backup while every affected worker is stopped.
Do not downgrade only the code over migrated databases.

Per-install snapshots are automatic recovery for a failed initializer while the
DSP remains fenced. They include the collection database and are not a general
later rollback command: restoring them after other plugin activity would rewind
unrelated queue state. Use the owner offline backup/restore flow for a later
rollback. Uninstall retains code versions and data; deleting a connection or DSP
is a separate explicitly authorized operation.
