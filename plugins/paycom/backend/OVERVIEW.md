---
title: Paycom plugin overview
status: current
last_verified: 2026-09-02
---

# Paycom Collector

The Paycom collector gathers pay periods, employee rosters, canonical employee-period resource links, and employee timecards. Browser-backed methods authenticate through the Dispatch Auth Broker; deterministic link generation does not open Paycom. The collector is managed through the central Collection Manager and does not contain a scheduler, retry loop, credential vault, Hermes tool, or agent-specific integration.

Shared provider ownership is described in [`../OVERVIEW.md`](../../README.md); this file covers Paycom-specific behavior.

## Implemented methods

| Method | Behavior |
|---|---|
| `collector.health` | Checks collector storage and Auth Broker availability without collecting. |
| `pay-periods.discover` | Publishes the previous, current, and next biweekly periods projected from the approved Sunday anchor. |
| `collection.resolve-targets` | Resolves standard collection dates and ranges into unique exact Paycom pay periods without collecting. |
| `roster.snapshot` | Captures the exact Paycom employee-search API response, validates membership and schema, and publishes a complete roster. |
| `roster.period` | Collects and publishes the authoritative roster for one exact Saturday period end. |
| `resource-links.current-period` | Generates and publishes one canonical timecard-summary link per active current-period employee. |
| `resource-links.period` | Generates the same complete link manifest for an exact roster period. |
| `resource-links.audit` | Recomputes link coverage, URLs, roster binding, and publication integrity without browsing. |
| `timecards.current-period` | Collects all active employees for the current period. |
| `timecards.period` | Captures the requested period's roster, then collects exactly that historical membership for a caller-specified Saturday period end. |
| `timecards.from-published-roster` | Collects an exact period from an already-published authoritative roster and fences activation to that roster revision. |
| `timecards.audit` | Revalidates an exact-period roster/timecard binding, every stored record, complete membership, identities, hashes, and relational projections without browsing. |
| `timecards.incremental` | Fills employees missing from an existing period snapshot and republishes complete current-roster membership. |
| `reconcile.current-period` | Audits current-period timecard membership against the active roster without opening a browser. |
| `sync.current-workforce` | Collects the complete visible current workforce and immediately publishes additions, edits, timecard changes, unknown transitions from absence, and explicit active/inactive transitions without deleting employees. |

Timecards use the source's bounded `maxConcurrency` value (`1`–`6`, currently `6`) inside one broker-authenticated browser. Each worker now keeps one reusable CDP page target for multiple employees instead of creating and connecting a fresh target for every timecard. Nonessential image, font, and media resources are blocked, while document capture, DOM extraction, exact employee/period validation, complete-membership reconciliation, private staging, and atomic publication remain unchanged. A target is discarded and recreated before retrying a transient page failure.

Successful timecard receipts include identifier-free performance counters: total browser time, collection time, worker and target-open counts, retry count, item p50/p95/max durations, and p50/p95/max phase timings for target open, navigation, response, load, response-body verification, readiness, extraction, and validation. They never include employee identities, provider URLs, or browser/authentication material.

### Performance evidence

Successful receipts provide bounded identifier-free wall-time, phase, worker, target-open, and retry aggregates so an operator can compare repeated supervised runs without exposing workforce data. Repository documentation does not retain one installation's workforce counts, run durations, current publication, or benchmark result. A concurrency or transport optimization is accepted only after repeated local measurements preserve exact target membership, persistence proof, atomic publication, cleanup, and lease release.

## Standard collection interface

The `paycom-main` source declares standard scopes `roster`, `links`, `timecards`, and `full`. It supports current, latest-complete, exact date, today/yesterday, inclusive range, rolling days/weeks, and exact-period selectors through the Dispatch SDK and unified CLI. A preview resolves dates to exact period-ending Saturdays without collecting. The standard `timecards` and `full` graphs publish the authoritative period roster once, collect timecards from that exact publication, fence activation to its ID and content hash, and run `timecards.audit` before downstream work. Verify mode audits existing timecard and/or resource-link publications without provider collection.

See the [Collection Manager overview](../../../runtime/collection-manager/OVERVIEW.md) for collector registration and scheduling.

For a new managed installation, Provisioner `0.5.0` loads this same reviewed definition, validates the code-owned release-tree/specification/executable digests and version `0.17.2`, fixes source/profile `paycom-main`, derives timezone from Access Control, and requires exact configuration attestation. Activation first starts or reuses one job-bound `paycom-periods` manager run, then runs the standard `current`/`full` workforce graph in `refresh` mode with a separate fenced activation-job idempotency key. The pay-period run and all five roster/timecard/link/audit runs must succeed, the manager database/queue must be clean and idle without critical sync alerts, and the managed sync must remain stopped/idle. The catalog-hashed `dispatch-paycom-activation-evidence` helper privately reads both stores and binds the current preparatory run plus exact workforce verification-run IDs, immutable publication-origin runs, active publication IDs, and content digests while binding the selected target to the preparatory pay-period run; Core invokes it through a bounded no-shell stdin/stdout adapter. Access Control persists the closed evidence bundle/digest atomically with `ready`. A stale worker cannot cancel shared work; only a current deadline holder may cancel and drain its exact run or batch. The managed sync stays stopped until a later explicit action.

This activation uses the normal plugin publication transactions; there is no alternate activation writer or direct SQLite readiness shortcut. Failed or partial work remains unroutable, preserves prior active pointers, and cannot touch another runtime or the existing local EXMP store.

Paycom `0.17.2` registers `paycom-main-workforce` with full-workforce `reconcileBatchSize=100` and `publishMode=additions_edits`. The compatibility `lookbackPeriods` setting is accepted only as `1`; larger values fail validation rather than being silently ignored. One public `dispatch sync start paycom-main-workforce` command ensures the managed Auth Broker is ready, advances the lifecycle generation, and queues the first tick immediately. Missing previously active employees publish as `lifecycleStatus=unknown` while retaining the last verified timecard and link; only explicit source evidence publishes `inactive`. Repeated start is idempotent, restart creates a new generation, and stop cancels active or queued sync work before returning.

Every additions/edit tick performs a persisted read-back proof before commit. The active publication is re-audited, and every timecard selected and observed during the tick must have the same full normalized business hash in SQLite. Because that hash covers the complete timecard record, a new or edited punch, kind, time, allocation, exception, comment, waiver, approval, attestation, or total cannot be acknowledged unless the matching normalized value is active in the database. A mismatch fails the tick with `integrity_failed` and rolls back. `no_change` ticks prove the selected observations equal the existing active publication. Receipts expose explicit source `businessDate`/`businessTimezone`, aggregate `persistence` counts, and a transaction-bound aggregate `delta` covering timecard/day/punch/approval and data-quality transitions. Schema version 5 writes the same privacy-safe evidence to durable `paycom_sync_change_history`; it contains no employee identity, punch time, or record value. Repetitive no-change ledger rows older than 365 days compact to one per source/target/business date; published change rows are preserved.

Version `0.17.0` added one absolute 120-second deadline per timecard item with worker-target retirement, one bounded retry, and sibling CDP cancellation after the first terminal error. Version `0.17.1` corrects period enforcement: the exact closed roster POST is rewritten to the requested deterministic current period, while the page's original UI default is not misclassified as authoritative provider-calendar evidence. Version `0.17.2` selects the one rendered punch-time child and ignores Paycom's hidden duplicate-time element while retaining fail-closed ambiguity checks. Successful receipts report `requestedPeriodEnforced:true`; `pay-periods.discover` remains deterministic. The collector rejects a source-local midnight rollover as `business_date_changed` before publication. Rendered navigation remains the production path; no fixed authenticated request path is enabled without full normalized parity evidence.

Timecard collection stores a canonical URL without the browser-only cache buster and separates the normalized business hash from the raw source evidence hash. Existing `sourceSha256` values remain evidence hashes; new rows also carry `businessSha256` and per-row `observedAt`. SQLite schema version 4 extends private `paycom_sync_state` and `paycom_sync_employees` rows with timecard business hashes, oldest-first observation timestamps, full-verification timestamps, and a full-reconciliation cadence anchor.

### Provider acceptance boundary

The registered Paycom roster, timecard, and resource-link paths have undergone supervised provider acceptance. Operational run identifiers, business dates, workforce counts, punch aggregates, and current service state are local-only and intentionally excluded from this repository. Absence remains retention-only and is never interpreted as confirmed deletion.



## Security boundary

The collector receives an opaque loopback CDP endpoint only after the Auth Broker completes Paycom login. The collector never receives the broker credential object, password, or security PIN values.

The collector has full post-login browser access and is therefore trusted with the resulting authenticated session, Paycom page data, cookies, and authorization state. Those values must never be printed, placed in a Collection Manager specification, or persisted in receipts.

Browser leases use a short renewable TTL. The wrapper renews while collection is alive, releases normally in `finally`, and attempts immediate release on `SIGTERM` or `SIGINT`. If a collector is killed without cleanup, the lease expires automatically.

## Authentication input and session reuse

Paycom first checks the DSP-owned saved browser session in headless Chrome. If a
fresh credential or numbered-PIN form requires input, the adapter asks the broker
to close Chrome gracefully and reopen that same profile in a normal window. The
broker permits one such transition before any credential submission, retaining
exclusive profile ownership and the existing attempt guard.

The normal window uses a private, authenticated Xvfb display and an explicit
loopback debugging port. PIN fields are checked against their labels and hidden
indices, focused through the operating system, checked for focus, and typed using
X11 keyboard events. The actual Continue button receives an operating-system
mouse click. Credential values remain in memory and the encrypted vault; input
helper commands travel over stdin and are never logged. Primary credential form
handling remains unchanged. Protected application verification and removal of
credential-bearing tabs still precede collector handoff.

The host must supply Xvfb, Python 3, libX11 and libXtst for fresh authentication;
the managed directory runtime can use its existing read-only host tools. No new
browser framework or continuously running display is required. Ordinary saved
session collection stays headless. Display startup, browser errors, cancellation
and lease release clean up owned processes and private Xauthority files. Browser
profiles, credentials and collected databases remain in the DSP private roots.

The separately configured [host browser assistance](../../../host/browser-assistance/README.md)
can handle CAPTCHA during sign-in and the initial collection handoff. Unexpected
verification, changed forms and provider rejection preserve verification guards.
Local browser tests verify the input and session lifecycle; reuse of a live saved
session is reported separately from fresh provider acceptance.

## Temporary collection files

Parsed publication candidates are private JSON files under
`dsps/<dsp-id>/staging/plugins/paycom/<run-id>.attempt-<n>/`. Every collection
removes its staging before reporting success, including folders from earlier
attempts of that same run and a replay of an already committed result. Cleanup
checks that the directories are gone and syncs their parent directory. Partial
staging-write failures also remove their owned files. Other runs' staging is
left to those runs.

If cleanup cannot complete, the collector reports `stage_cleanup_failed` instead
of acknowledging success. An already committed database update remains valid;
an idempotent retry can finish cleanup. This covers normal completion, handled
errors and retries; an uncatchable process or host failure may leave staging
until that run is retried. Saved authentication state, durable collection receipts,
retained data and SQLite-managed WAL/SHM files are outside staging cleanup.

## Publication model

Data is stored in:

```text
<data-root>/paycom/paycom.sqlite3
```

Collection follows:

```text
roster publication -> roster-bound collection -> private staging candidate
                   -> validate -> SQLite transaction -> activate publication
                   -> exact-period timecard audit -> remove staging
```

`active_publications` and `active_resource_link_publications` point to current versions. Prior publications are retained. Partial collection never advances an active pointer. Canonical timecard business records and user-facing links exclude the browser-only `dispatch_timecards` cache buster; raw HTML hashes remain separate evidence. See `references/data-contract.md`.

## Collection Manager

The registered source is `paycom-main`. It refers to Auth Broker profile `paycom-main`; that is only an identifier and contains no credentials.

Inspect the collector through the existing management tool:

```bash
CTL=./runtime/collection-manager/bin/dispatch-collectionctl
$CTL collector paycom
$CTL methods paycom
$CTL source paycom-main
$CTL plans
```

Run non-authenticated checks:

```bash
$CTL run paycom-health
$CTL run paycom-periods
$CTL run paycom-current-resource-links
$CTL run paycom-resource-links-audit
$CTL run paycom-period-timecards-audit
$CTL drain 60000        # only when the manager daemon is stopped
```

Queue authenticated collection:

```bash
$CTL run paycom-roster
$CTL run paycom-current-timecards
$CTL run paycom-incremental-timecards
```

Inspect or start the managed sync:

```bash
./bin/dispatch sync status paycom-main-workforce
./bin/dispatch sync history paycom-main-workforce --limit 100 --offset 0
./bin/dispatch sync start paycom-main-workforce
./bin/dispatch workforce status
./bin/dispatch workforce employees --lifecycle unknown --limit 50
./bin/dispatch workforce timecards --limit 50
./bin/dispatch workforce punches --date 2026-08-30 --kind in_day --from-time 10:01 --limit 50
```

The sync schema contains only `reconcileBatchSize`, `fullReconcileMinutes`, `lookbackPeriods`, and `publishMode`; deletion settings are absent and `lookbackPeriods` is fixed to `1` until a real multi-period publication contract exists. Terminal authentication projects `blocked` and uses delayed probes rather than duplicate full attempts. `dispatch workforce` reads the active roster, timecard summaries, canonical links, and protected minimal punch rows under one consistent SQLite snapshot without triggering collection. Live run and workforce evidence remains local-only.



For a historical period, first inspect the method schema, then provide a bounded override file:

```json
{"periodEnd":"2026-09-05"}
```

```bash
$CTL run paycom-period-timecards /absolute/path/to/input.json
$CTL run paycom-period-timecards-from-roster /absolute/path/to/input.json
$CTL run paycom-period-timecards-audit /absolute/path/to/input.json
```

The default historical period in the checked-in specification is an example/current bootstrap value. Use an override for another period.

All collector plans remain manual. The Collection Manager owns the durable `paycom-main-workforce` interval, start/stop/restart/edit lifecycle, retries, coalescing, and run history.

## Credential enrollment and live prerequisites

Credentials must be enrolled locally using the Auth Broker's dedicated controlling-terminal wizard. Stop the broker, then run:

```bash
./runtime/auth-broker/bin/dispatch-paycom-credentials enroll
```

The command defaults to profile `paycom-main`, disables terminal echo, and requires every value twice before committing the encrypted profile. It returns metadata only. Never send credentials through chat or place them in argv, environment variables, redirected stdin, logs, tests, Collection Manager inputs, or ordinary files.

After successful enrollment, restart the Auth Broker and verify the profile without exposing values:

```bash
./runtime/auth-broker/bin/dispatch-auth-brokerctl status paycom-main
```

A real roster or timecard run requires:

1. A locally enrolled `paycom-main` Auth Broker profile.
2. Current Paycom login, security-PIN, roster API, and timecard DOM layouts matching the fail-closed adapters.
3. A successful `paycom-roster` run before dependency-bound standalone timecard plans can run.

`dispatch sync start paycom-main-workforce` automatically starts and validates the managed Auth Broker before changing sync state. The broker may advance only the exact allowlisted Paycom security-profile campaign through its fixed three-step `Not Now`/warning/`Continue` sequence. Unknown setup pages, generic continue/skip controls, login-layout drift, CAPTCHA, MFA, lockout, unexpected URLs, malformed timecards, and unexpected roster members fail closed. A returned strict subset is observation-only and retains every absent prior employee.

Current, incremental, and roster-bound exact-period timecards require an audited active roster whose target is the same period end. The candidate records that roster publication ID and content hash; publication rechecks both inside the activation transaction, so a changed roster fails closed. Standalone `timecards.period` retains its self-contained historical membership capture for callers that have not first published an exact-period roster.

## Component commands

```bash
./tooling/build
./tooling/test
./tooling/verify
./tooling/health
```

The Collection Manager specification is:

```text
config/collection-manager.json
```

Apply it with:

```bash
$CTL apply ./plugins/paycom/backend/config/collection-manager.json
```

`apply` is an upsert and does not prune unrelated manager records.
