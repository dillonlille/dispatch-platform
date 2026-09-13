---
name: collection-manager
title: Collection Manager skill
description: "Use when managing Dispatch collectors, plans, or runs."
version: 1.0.0
author: Dispatch
platforms: [linux]
status: current
last_verified: 2026-09-02
metadata:
  hermes:
    tags: [dispatch, collectors, scheduling, queue, automation, operations]
---

# Collection Manager

Use this skill whenever an agent needs to inspect, configure, schedule, run, pause, resume, retry, cancel, or troubleshoot a Dispatch collector.

## Commands and boundary

```bash
DISPATCH=./bin/dispatch
CTL=./runtime/collection-manager/bin/dispatch-collectionctl
```

Use `$DISPATCH` for supported application operations: standard collection preview/enqueue/batches/schedules, sync lifecycle, and system status. Use `$CTL` only for component-local registry administration, daemon/drain recovery, exact internal diagnostics, and declarative bootstrap. Never use component sync mutations for an authenticated source: they intentionally bypass the application-level Auth preflight.

Every command returns one JSON object. Read `ok`, `status`, and `data`; do not infer success from prose. List commands, including `runs`, return `data.items`, `data.total`, `data.limit`, `data.offset`, and `data.hasMore`; continue with the next offset until `hasMore` is false. For `run-status`, the top-level `status` and `data.status` are the run lifecycle state.

## Start safely

Always begin with:

```bash
$DISPATCH status --json
$CTL collectors
$CTL sources
$CTL plans
```

Before constructing input for a method, inspect its exact closed schema:

```bash
$CTL methods <collector-id>
$CTL plan <plan-id>
```

Read method rows from `data.items`. Do not guess method names or fields.

## Vocabulary

- **Collector**: implementation package, such as `paycom`.
- **Method**: one capability, such as `roster.full` or `timecards.period`.
- **Source**: configured account/tenant using a collector. It references an Auth Broker profile by ID.
- **Plan**: source + method + default input + schedule + dependencies.
- **Run**: one durable execution. Retries remain attempts under that run.

## Easy operations

### Queue a plan with its default input

```bash
$CTL run <plan-id>
```

Capture `data.id` from the response. Inspect it with:

```bash
$CTL run-status <run-id>
```

### Queue a bounded input override

Create a small JSON file containing only fields advertised by `$CTL methods <collector>` and run:

```bash
$CTL run <plan-id> /absolute/path/to/input.json
```

Plan input and override input are merged, then checked against the method's closed schema.

### List recent runs

```bash
$CTL runs 50 0
```

### Pause or resume automation

```bash
$CTL pause <plan-id>
$CTL resume <plan-id>
```

Pausing prevents new scheduled or manual runs. Runs already queued continue and must be cancelled separately if they should not execute. Pausing does not terminate a run already executing.

### Cancel or retry

```bash
$CTL cancel <run-id>
$CTL retry <run-id>
```

Cancel only queued/running runs. Retry only failed/cancelled runs. Never create repeated manual runs merely because a run is still queued or running.

### Process work without the daemon

First confirm `status.data.manager.running` is `false`, then:

```bash
$CTL drain 30000
```

Never call `drain` when the daemon is running. The manager lease will reject it. Interpret the result exactly:

- `idle`: no queued or running work remains;
- `deferred`: no work can run now, but `data.pending` lists retry-delayed or dependency-blocked work;
- `drain_timeout`: the deadline was reached, active runs were cancelled, and `data.cancelledRunIds` identifies them.

## Apply configuration

The active configuration is stored in the manager database. Apply an absolute JSON specification path:

```bash
$CTL apply /absolute/path/to/collection-spec.json
```

`apply` is an **upsert**, not a prune. Omitted collectors, sources, and plans are not deleted. Inspect all lists after applying.

A specification contains:

1. `collectors` with absolute executable paths or the trusted leading `${DISPATCH_PROJECT_ROOT}/` token and method contracts;
2. `sources` with non-secret config and optional `authProfile` identifiers;
3. `plans` with schedules, default inputs, and dependencies.

See `references/specification.md` before creating or changing a specification.

## Run-state handling

- `queued`: waiting for time, dependency freshness, or a lock.
- `running`: collector subprocess is active.
- `succeeded`: bounded receipt validated and stored.
- `failed`: attempts exhausted, including a manager restart after the retry budget was exhausted.
- `cancelled`: cancelled before completion.

A queued run with `blocked: "dependency:<plan>"` needs a fresh successful dependency run. Do not bypass the dependency by invoking the collector directly.

## Strict safety rules

1. Never put passwords, PINs, tokens, cookies, authorization headers, or connection strings in a spec, source config, input file, skill, receipt, argv, or environment variable.
2. Use only an `authProfile` identifier. The Auth Broker owns credentials and authenticated sessions.
3. Never run a collector executable directly for scheduled or queued work; use a plan so the manager records locks, attempts, receipts, and freshness.
4. Do not edit the SQLite database directly.
5. Do not invent arbitrary commands, URLs, environment variables, or shell arguments. Collectors receive a fixed request on stdin.
6. Use `pause`, not destructive configuration changes, to temporarily stop automation.
7. For historical collection, use a method that explicitly advertises bounded date/window fields and inspect its schema first.
8. Report collection readiness separately from data freshness and authentication readiness.
9. Treat `status`, verification, and other queries as read-only. A missing database means `not_initialized`; do not initialize storage merely to inspect it.
10. Resolve configured roots through the SDK/runtime configuration rather than assuming mutable state always lives under the source tree.

## Managed sync operations

Authenticated sync policy belongs to the application layer. Use:

```bash
$DISPATCH sync status <sync-id> --json
$DISPATCH sync start <sync-id> --json
$DISPATCH sync stop <sync-id> --json
$DISPATCH sync restart <sync-id> --json
$DISPATCH sync run <sync-id> --json
```

These commands start/validate the managed Auth Broker and require the configured profile/provider match before mutation. Component-local `start-sync`, `restart-sync`, `run-sync`, and authenticated `edit-sync --apply-now` are recovery/admin protocols, not the supported interface boundary.

## Troubleshooting order

```bash
$CTL status
$CTL run-status <run-id>
$CTL runs 50 0
$CTL methods <collector-id>
$CTL plans
```

Interpret stable run errors instead of exposing collector stderr. Common conditions:

- `dependency:<plan>`: dependency is absent or stale.
- `collector_unavailable` / `unsafe_collector`: configured executable is missing or unsafe.
- `collector_timeout`: method deadline expired.
- `invalid_receipt`: collector violated the one-object receipt contract.
- `collector_output_limit`: stdout or stderr exceeded its bound.
- `manager_restarted`: execution was interrupted; the manager automatically requeues it when retry budget remains.
- `input_not_found` / `input_unreadable`: the specification or input JSON path is missing or cannot be read safely.

For component internals, read:

`runtime/collection-manager/OVERVIEW.md`
