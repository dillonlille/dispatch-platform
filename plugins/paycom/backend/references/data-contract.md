---
title: Paycom collector data contract
status: current
last_verified: 2026-09-02
---

# Paycom collector data contract

The collector owns `<data-root>/paycom/paycom.sqlite3`.

Each collection creates a private staging candidate, validates it, publishes it in one SQLite transaction, advances the appropriate active pointer, verifies row counts and database integrity, and then removes staging. Prior publications remain available for rollback or audit. Read interfaces use `PaycomStore.activeWorkforce()` in read-only mode: roster, timecards, and resource links are read under one SQLite snapshot and their roster publication bindings are checked before any public DTO is returned.

Published kinds:

- `pay_periods`: previous/current/next biweekly period boundaries.
- `roster`: complete employee records, including active and active-driver flags.
- `timecards`: one complete active-employee snapshot for a period; legacy rows retain validated Paycom DOM projections and raw source hashes, while new semantic rows also store canonical cache-buster-free URLs, normalized business hashes, and per-row observation times.
- `resource_links`: one canonical URL per employee who is active in the exact bound roster publication and period. Link publications are stored in dedicated tables, use a separate active pointer, and contain no credentials, sessions, cookies, or browser-only cache-busting parameters.

## Stored business fields

Normalized roster records may contain:

- employee code and name;
- canonical lifecycle status plus explicit Paycom active state;
- department and delivery-station codes/descriptions;
- position title, pay class, terminal group, pay type, and primary supervisor;
- roster-summary missing-punch, total-hours, overtime-hours, employee-approval, and supervisor-approval values;
- driver-department, driver-position, and active-driver classifications.

A private timecard row contains employee identity, source/business hashes, observation time, and a validated normalized record. The normalized record contains:

- period start/end/key, weekly totals, and period total hours;
- exactly 14 day rows with date/weekday, pay code, allocations, hours, total hours, dollar amount, exceptions, waiver state, comments, unresolved slots, and missing-punch state;
- zero or more additional rows for the same period;
- punches with slot/type, displayed/actual/rounded time, clock code/name, comments, provenance availability, approval/change-request status, current/requested direction, operation, and change note;
- approval, attestation, and meal-waiver table projections when present;
- a fixed canonical Paycom source route and extraction format/version.

Resource-link rows contain employee code and one canonical `paycom.timecard.summary` HTTPS URL for the bound period. Pay-period rows contain start, end, key, and `previous`/`current`/`next` relation.

## Public workforce boundary

Applications must use `dispatch.workforce` rather than reading these tables. The public employee DTO intentionally exposes only identity, lifecycle, department, delivery station, position, pay class/type, supervisor, and driver classification. The public timecard DTO exposes period bounds, total hours, missing-day count, observation time, lifecycle, and canonical link. Raw punches, comments, allocations, exceptions, approvals, attestations, waivers, source/business hashes, publication IDs, and record JSON remain protected plugin data.

## Sync persistence proof

For `additions_edits`, the collector does not treat browser collection or a successful SQLite write call as proof that detailed timecards were saved. Before the transaction commits, it:

1. reloads and fully audits the active roster-bound timecard publication;
2. recalculates its content hash from persisted `record_json` values and relational projections;
3. compares every timecard selected and observed during the tick with the active row using the full normalized business hash;
4. requires the configured source-timezone date to exist in every active timecard;
5. emits aggregate daily punch coverage only after all checks pass.

The business hash includes the entire normalized record except the browser-only cache-buster in the source URL. Punch additions/edits, kinds, displayed/actual/rounded times, clock provenance, change-request details, allocations, exceptions, comments, waivers, approvals, attestations, and totals therefore participate in equality. A mismatch raises `integrity_failed`; the encompassing SQLite transaction rolls back active pointers and sync observation state. A valid `no_change` tick performs the same selected-row comparison against the already-active publication.

The receipt's `persistence` object is aggregate-only: `verified`, coverage date, publication metadata, active timecard/date-row counts, selected/persisted/mismatch counts, total punches, each normalized punch-kind count, and timecards containing `IN DAY`. It contains no employee code, name, punch time, clock, comment, allocation, or exception value. Shadow/baseline-required/preview modes do not claim persistence because they do not activate business data.

The same transaction computes a `delta` by comparing the prior active timecard graph with the candidate graph before commit. The closed aggregate shape counts roster and timecard additions/changes/removals, changed day sections, punch additions/edits/removals, added/removed punch kinds, missing-punch and unresolved-slot transitions, and changed approval, attestation, meal-waiver, additional-row, comment, and total sections. Punch identity is used only inside the transaction; the result contains no employee code, date-row key, slot, time, or business value. `no_change` produces a zero mutation delta while still reporting the unchanged active timecard count.

## Publication and retention metadata

The database also stores publication/run identity, collected/activated timestamps, row counts, metadata, content hashes, active pointers, attempt fences, and roster bindings. The active publication plus one prior publication is retained per kind/target for rollback and audit, so physical table row counts can exceed the current workforce count. Private sync tables retain one source/target checkpoint plus per-employee profile, summary, and timecard fingerprints and observation/full-verification timestamps for change detection. Schema version 5 adds `paycom_sync_change_history`: one idempotent privacy-safe row per committed ready run containing source/target, business date/timezone, observed time, disposition, validated aggregate delta JSON, and persistence JSON. It deliberately has no employee identity or punch-detail columns and survives full-publication pruning. Bounded post-commit housekeeping compacts only `no_change` rows older than 365 days to one row per source/target/business date; published/change rows and recent rows are retained.

Schema version 4 introduced private `paycom_sync_state` and `paycom_sync_employees` observation tables. They hold source, profile, summary, normalized timecard fingerprints and observation/full-verification times. Legacy removal columns remain only for schema compatibility and are always cleared to zero/null; sync never confirms or publishes deletions. Published roster records carry canonical `lifecycleStatus`: visible positive status maps to `active` or `inactive`, while a previously active employee absent from the active-only source becomes `unknown`. Unknown records retain their last verified timecard/link state. A visible return maps unknown→active; only positive inactive evidence removes active-only dependent membership.

The public protected Workforce punch query does not expose these private tables. It derives a minimum DTO from one coherent `activeWorkforce()` read transaction and emits employee name, lifecycle, date, normalized kind, local `HH:MM`, actual/displayed basis, and observation/collection context only. Employee code, source URL, punch comments, allocations, exceptions, approvals, publication identity, and hashes remain private.

The authenticated dashboard also uses the protected Workforce daily projection. Daily rows include employee identity, date, grouped punch times and their actual/displayed basis, reported hours, missing-punch state, a derived condition, and observation time. An employee lookup may return up to 14 of these same projected rows alongside the existing employee profile and period summary. It never exposes raw record JSON, comments, clocks, allocations, approval tables, attestations, waivers, hashes, or publication identifiers. Both dashboard employee endpoints require `workforce.read` and use the session-selected DSP runtime.

Daily date lookup selects the saved roster-bound period containing the requested date when available, including previously collected periods. It never initiates collection. Uncollected dates return `available: false` with no employee rows; dates with no activity in a saved period remain distinguishable. Explicit daily sorting occurs before pagination; time columns compare the first source-order punch, hours compare numerically, and empty values stay last for ascending and descending orders.

No password, PIN, cookie, authorization header, CDP endpoint, lease token, or browser profile path may be stored in this database or emitted in a receipt.
