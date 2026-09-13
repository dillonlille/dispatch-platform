---
title: Dispatch plugin directory
status: current
last_verified: 2026-09-02
---

# Dispatch plugins

`compatibility/providers/` holds provider-specific integrations. Each provider owns its collection behavior and persistence. Runtime application, orchestration, authentication, CLI, and SDK infrastructure live alongside providers inside [`runtime/`](../../docs/architecture.md). Central accounts, provisioning, and fleet updates belong to [`core/`](../../core/OVERVIEW.md).

## Current plugins

| Plugin | Status | Purpose | Documentation |
|---|---|---|---|
| `paycom/` | Current and live-accepted | Paycom roster, detailed timecards, punches, resource links, lifecycle reconciliation, atomic publication, persistence audits, and privacy-safe aggregate change history. | [`paycom/OVERVIEW.md`](../../plugins/paycom/backend/OVERVIEW.md) |
| `cdf/` | Mixed; fixture-accepted | Exact-week CDF collection, immutable artifact publication, broker-aware health, and a disabled polling window. The live Amazon flow remains blocked pending supervised provider acceptance. | [`cdf/OVERVIEW.md`](../cdf/OVERVIEW.md) |

## Plugin ownership

A plugin owns:

- provider navigation after authenticated handoff;
- provider routes and response interpretation;
- domain parsing and validation;
- business reconciliation and fingerprints;
- private staging, database schema, migrations, publication, rollback, and audit;
- plugin-specific worker, configuration, tests, scripts, references, and documentation.

A plugin does **not** own:

- credentials, login secrets, or authenticated browser-profile lifecycle;
- generic schedules, desired state, retries, locks, cancellation, or run history;
- public application workflow composition;
- reusable CLI or SDK presentation infrastructure.

Those concerns belong to the other DSP runtime components.

## Expected plugin layout

A working plugin should keep its implementation together under one directory:

```text
compatibility/providers/<plugin-id>/
├── OVERVIEW.md
├── dispatch-plugin.yaml
├── package.json
├── bin/                  # fixed worker or plugin CLI entry points
├── config/               # non-secret declarative registration
├── src/                  # provider/domain implementation
├── tests/                # fixture and contract coverage
├── tooling/              # build, test, verify, and health commands
└── references/           # data contracts and provider-specific notes
```

Not every plugin has every directory yet, but new plugin behavior should not be placed in `core/` merely for convenience.

## Runtime boundary

The Collection Manager launches a plugin's registered worker with one bounded JSON request and accepts one bounded sanitized receipt. Authentication is requested from the Auth Broker by profile identifier; credentials never enter plugin configuration or manager receipts. Business data remains plugin-owned and is exposed to applications only through an approved typed read boundary.

Core source must not add imports of plugin implementation modules. Run:

```bash
./core/tooling/verify-plugin-boundary
```

The verifier rejects Core imports of DSP implementations. There is no provider import allowlist. Core and each DSP communicate through the shared `shared/` contracts.

## Maintaining a provider

When behavior changes, update the provider overview and closest data contract, run its build and tests, and run the repository boundary verification above.
