---
title: Collection Manager overview
status: current
last_verified: 2026-09-02
---

# Dispatch Collection Manager

Provider implementations live in [`../providers/`](../../plugins/README.md).

The Collection Manager is the durable local control plane for every Dispatch collector. It owns registration, source instances, collection methods, schedules, durable runs, dependency gates, retries, resource locks, cancellation, and bounded collector subprocess execution.

Collectors own domain collection and validation. The manager owns when and how they run.

## Current capabilities

- Declarative collector/source/plan specifications.
- Multiple methods per collector and multiple source instances per collector.
- Manual, interval, and five-field cron schedules with IANA timezones.
- Durable SQLite queue and run history.
- Idempotent schedule keys that suppress duplicate interval/cron runs.
- Freshness-bounded plan dependencies.
- Four concurrent workers by default with source and declared resource locks.
- Retry attempts with bounded backoff.
- Pause, resume, cancel, manual retry, and offline drain controls.
- Exact collector executable validation and release version snapshots per run.
- Strict closed method input schemas.
- Collector requests over stdin and one bounded JSON receipt over stdout.
- Sanitized failures; collector stderr is never persisted.
- Secret-bearing configuration keys are rejected. Sources reference auth profiles by identifier only.
- Standard source capability discovery and non-mutating target preview.
- Current, latest-complete, exact-date, yesterday, range, rolling-duration, and exact-target selectors.
- Durable multi-target batches with exact run dependencies and preview-hash fencing.
- Standard relative-selector schedules shared by every capable collector.
- Plugin-registered polling sync definitions backed by existing manual plans.
- Sync start, stop, restart, run-now, edit revisions, history, deterministic jitter, and coalescing.
- Managed-installation first-publication support: exact server-owned Paycom definition attestation, job-bound pay-period/run and workforce-batch idempotency, exact five-plan graph verification, clean database/idle/no-critical-alert readiness evidence, and a private read-only batch-to-publication verifier. Stale activation workers do not cancel shared work. The manager contributes durable run receipts but never writes installation `ready`.

## Paths

```text
Component: ./runtime/collection-manager
Database:  <data-root>/collection-manager/collection-manager.sqlite3
Skill:     ./docs/agent-skills/collection-manager/SKILL.md
```

`DISPATCH_LOCAL_ROOT` derives external development data and state directories. Without it, new installations use XDG roots. Individual `DISPATCH_DATA_ROOT` and `DISPATCH_STATE_ROOT` values or explicit SDK runtime options may override the defaults. `resolveLocalRuntimePaths()` is authoritative for local mode and rejects mutable roots inside the source worktree. A Provisioner-managed service sets a fixed internal managed-runtime marker; worker launch then requires the complete authority-derived component/provider environment, rejects local-root and Access Control selectors, and never falls back to local/XDG storage.

The database directory is mode `0700` and the database is mode `0600`.

## Operator CLI

```bash
CTL=./runtime/collection-manager/bin/dispatch-collectionctl

$CTL help
$CTL init
$CTL apply /absolute/path/to/collection-spec.json
$CTL status
$CTL collectors 50 0
$CTL collector paycom
$CTL methods paycom
$CTL sources 50 0
$CTL source paycom-main
$CTL plans 50 0
$CTL plan paycom-current-timecards
$CTL run paycom-current-timecards
$CTL runs 50 0
$CTL run-status <run-id>
$CTL pause <plan-id>
$CTL resume <plan-id>
$CTL cancel <run-id>
$CTL retry <run-id>
$CTL collection-describe paycom-main
$CTL collection-preview /absolute/path/to/request.json
$CTL collection-enqueue /absolute/path/to/request.json /absolute/path/to/options.json
$CTL batches 50 0
$CTL batch <batch-id>
$CTL cancel-batch <batch-id>
$CTL retry-batch <batch-id>
$CTL collection-schedules
$CTL put-collection-schedule /absolute/path/to/schedule.json
$CTL run-collection-schedule <schedule-id>
$CTL syncs
$CTL sync <sync-id>
$CTL start-sync <sync-id>
$CTL stop-sync <sync-id>
$CTL restart-sync <sync-id>
$CTL run-sync <sync-id>
$CTL edit-sync <sync-id> /absolute/path/to/patch.json
$CTL sync-history <sync-id>
```

All commands return one bounded JSON object. List commands, including `runs`, are paginated under `data.items` with `total`, `limit`, `offset`, and `hasMore`. `run-status` uses the run lifecycle state as its envelope status. `apply` is an upsert: it creates or updates declarations but does not delete omitted declarations.

When the long-running manager is not active, process queued work synchronously:

```bash
$CTL drain 30000
```

Do not use `drain` while the manager daemon is running; the single-manager lease rejects a second manager. `idle` means the queue is empty, `deferred` returns retry-delayed or dependency-blocked work under `data.pending`, and `drain_timeout` explicitly cancels and reports active run IDs.

Pausing a plan blocks new scheduled and manual runs. Existing queued runs continue unless cancelled separately; existing running work is not interrupted.

## Managed polling syncs

A plugin registers a sync by declaring a normal manual plan plus a top-level `syncs` entry in its manager specification. The manager owns desired state, interval, jitter, `coalesce` overlap, validated non-secret settings, configuration revision, lifecycle generation, scheduling, cancellation, and history. The plugin plan owns source checks, provider cursors, synchronization strategy, validation, reconciliation, and publication.

Each tick is an ordinary manager run. Starting queues an immediate tick; stopping cancels queued and active ticks and waits for cleanup; `--drain` allows the active tick to finish; restarting starts a new generation; editing increments the immutable configuration revision used by future ticks. A pending tick coalesces additional due windows.

The public interface is `dispatch.sync` and `./bin/dispatch sync ...`.

## Service

```bash
./tooling/start
```

The manager heartbeat appears under `status.data.manager`. A running daemon schedules due plans and processes queued runs. SIGINT and SIGTERM cancel active workers, release the manager lease, and close the database.

A hardened legacy-local user-service template is provided at `integration/systemd/dispatch-collection-manager.service.in`. Render the local Dispatch user-service units for the current checkout and an external local-data root with `core/tooling/render-systemd-units --local-root <absolute-local-root> --output-dir <absolute-unit-directory>`. Its `KillMode=control-group` ensures collector children are terminated with the manager during service stop or restart. Provisioner-managed DSPs instead receive the fixed server-owned Collection Manager within service-plan version `3`, alongside the Auth Broker, Runtime Gateway, and configured outbound Runtime Agent; the legacy renderer is not used for managed runtimes.

## Collector process contract

A collector is one owner-controlled, absolute, regular executable. It receives no command arguments and a single JSON request over stdin:

```json
{
  "protocolVersion": 1,
  "runId": "run_...",
  "plan": "paycom-main-timecards",
  "source": {
    "id": "paycom-main",
    "collector": "paycom",
    "authProfile": "paycom-main",
    "config": {}
  },
  "method": "timecards.period",
  "input": {},
  "attempt": 1,
  "deadline": "2026-08-25T12:00:00.000Z"
}
```

It must write exactly one newline-terminated JSON receipt and nothing else to stdout:

```json
{
  "ok": true,
  "status": "published",
  "data": {
    "rows": 500,
    "revision": "..."
  },
  "warnings": []
}
```

Successful statuses are `succeeded`, `published`, and `no_change`. Failures use:

```json
{"ok":false,"status":"failed","error":{"code":"stable_error_code"}}
```

Collectors must write logs to their own private operational location, not stdout. The manager discards stderr and stores only bounded receipts or sanitized error codes.

## Scheduling and dependencies

Supported schedule shapes:

```json
{"type":"manual"}
{"type":"interval","seconds":900}
{"type":"cron","expression":"50 15 * * *","timezone":"America/Los_Angeles"}
```

A dependency requires a recent successful run of another plan:

```json
{"plan":"paycom-main-roster","maxAgeSeconds":86400}
```

A queued run remains blocked with `blocked: "dependency:<plan>"` until all dependencies are fresh.

Standard batches also persist exact run-to-run dependencies for every resolved target. Their source capability declaration points to a collector-owned resolver and maps scopes to existing registered plans.

## Concurrency

Every run automatically locks its source. Methods can declare additional keys:

```json
[
  "auth:{authProfile}",
  "collector:{collector}",
  "publish:paycom-timecards"
]
```

Supported substitutions are `{source}`, `{authProfile}`, `{collector}`, and `{method}`. This prevents two runs from sharing one browser/auth profile or publication target while allowing unrelated collectors to run concurrently.

## Security boundary

- Specifications, source config, method input, receipts, and run history must never contain credentials, cookies, tokens, PINs, or authorization headers.
- `authProfile` is only an identifier. Authenticated browser sessions are acquired through the separate Auth Broker; credentials and browser material are never stored in manager state.
- Collector commands must be absolute owner-controlled executables with no symlinks, extra hard links, or group/other write permissions.
- No collector receives inherited credential environment variables.
- Collector stdout and stderr are bounded; stderr is not retained.
- The manager does not expose arbitrary shell arguments, environment variables, URLs, or commands at run time.

## Lifecycle

```bash
./tooling/test
./tooling/build
./tooling/verify
./tooling/health
```

The source is canonical. Do not edit generated runtime copies if immutable releases are added later.
