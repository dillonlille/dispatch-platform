---
title: CDF collector
status: current
last_verified: 2026-09-02
---

# CDF collector

`compatibility/providers/cdf` is an independent, artifact-first Customer Delivery Feedback collector. Version `0.3.1` implements the fixed weekly Amazon browser source, exact-week validation, private staging, immutable publication, audit, broker-aware health, and the existing Collection Manager worker boundary. Browser and source behavior remain fixture-verified pending supervised Amazon acceptance.

Shared provider ownership is described in [`../OVERVIEW.md`](../README.md); this file covers CDF-specific behavior.

## Scope

This component is intentionally weekly-collection-only. It does not provide daily CDF collection, CDF search, driver lookup, summaries, report rendering, Hermes actions, or a CDF domain client in Dispatch Core. Daily collection and read-facing surfaces are unavailable.

## Current capability

Implemented and fixture-verified:

- Sunday-through-Saturday reporting-week resolution using exact `YYYY-W##` targets;
- completed-week rejection;
- exact validation of the three known CDF-negative CSV schemas;
- exact validation of all six CDF complaint columns and `0`/`1` values;
- row-to-requested-week binding;
- explicit support for a valid zero-complaint CSV containing only its header;
- week-bound provider-link validation;
- auxiliary provider-link degradation without invalidating a valid CDF CSV;
- owner-private staging;
- content-addressed immutable artifact directories;
- manifest and artifact hashing;
- an immutable collection metadata database with one active pointer per week;
- replay as `no_change`;
- replacement only through explicit `replace: true`;
- post-publication audit;
- one bounded stdin request and one newline-terminated JSON receipt;
- real fixture execution through the existing Collection Manager runner.
- explicit manual `exact-target` collection and inclusive `target-range` backfill of up to 64 completed weeks;
- one dynamic Auth Broker lease per weekly collection attempt;
- fixed code-owned Amazon feedback, quality, and provider-data routes;
- exact requested-week query binding and visible-week confirmation;
- bounded streaming download inside the authenticated browser;
- closed unavailable, authentication, challenge, wrong-page, timeout, content-type, and oversize states;
- lease renewal, signal handling, and release in `finally`;
- query-free fixed download provenance with redirect rejection; arbitrary AWS tenant hosts are forbidden;
- cooperative cancellation through browser, staging, publication, and cleanup plus orphan-stage recovery;
- cross-week active-pointer corruption detection;
- a disabled synthetic Collection Manager polling-window fixture that opens Tuesday at 15:00, checks every 15 minutes until Wednesday at 15:00, and freezes its declared example week across the window.
- broker-aware health that reports the configured source profile's closed authentication state without acquiring a browser;
- one-attempt manual collection, with availability-only repetition owned by the bounded polling window.

Not implemented or accepted:

- live acceptance of the fixture-registered Amazon Logistics Auth Broker adapter;
- live Amazon login or browser leasing for CDF;
- enabled recurring scheduling;
- any read/search/report interface.

The production worker requests the configured Auth Broker profile and runs the weekly source instead of using a placeholder fetcher. Installed profile, broker, challenge, and collection state is local-only and is not represented by the checked-in example declaration. Fixture success does not claim live Amazon acceptance.

`collector.health` performs only a metadata status request against the configured Auth Broker profile. It does not acquire a browser, submit credentials, or collect CDF data. Manual collection gets one bounded attempt; only the disabled polling window repeats `week_unavailable`, so terminal authentication and validation failures are not retried automatically.

## Methods

- `collection.resolve-targets`
- `collector.health`
- `cdf.week.collect`
- `cdf.week.audit`

Successful collection statuses accepted by the manager are:

- `published`
- `no_change`

A provider-link source failure may still return `published` with:

```json
{
  "warnings": ["provider_links_unavailable"],
  "data": {
    "providerLinks": "degraded",
    "providerLinkCount": 0
  }
}
```

The authoritative CDF CSV remains fully validated in that case. Raw browser/provider errors are never copied into the receipt.

## Publication layout

```text
<data-root>/cdf/
  cdf.sqlite3
  artifacts/
    2026-W20/
      <collection-digest>/
        cdf-negative.csv
        provider-links.json
        manifest.json
  .staging/
```

Artifact directories are immutable. The SQLite store contains aggregate publication metadata and the active collection pointer; it does not currently create query projections.

## Collection Manager registration

`config/collection-manager.json` declares the four methods and one `cdf` exact-week scope using synthetic `TST1`, `fixture-company`, and `fixture-dsp` identifiers. Operators must keep the real source declaration outside the repository. The three checked-in plans are manual and no collection is queued automatically.

`config/weekly-collection-schedule.json` declares a disabled `polling-window` in `America/Los_Angeles`. It opens Tuesday at 15:00, resolves and freezes `latest-complete`, retries only `week_unavailable` every 900 seconds, and stops at the Wednesday 15:00 cutoff. A verified publication ends retries immediately; authentication, validation, browser, and integrity failures are terminal. A manager restart inside the window catches up the original campaign without changing its target or deadline. The schedule must remain disabled until the live browser flow is accepted.

## Commands

From the project root:

```sh
./compatibility/cdf/scripts/build
./compatibility/cdf/scripts/test
./compatibility/cdf/scripts/verify
./compatibility/cdf/scripts/health
```

Protected Amazon profile setup must run from a controlling terminal:

```sh
./bin/dispatch setup auth --provider amazon-logistics --profile amazon-operations --test-auth
```

Manual exact-week collection and bounded backfill use the same SDK-backed manager path:

```sh
./bin/dispatch collect preview cdf-example cdf --target 2026-W34 --json
./bin/dispatch collect target cdf-example cdf 2026-W34 --idempotency cdf-week-2026-W34

./bin/dispatch collect preview cdf-example cdf --from-target 2026-W20 --through-target 2026-W34 --json
./bin/dispatch collect backfill cdf-example cdf 2026-W20 2026-W34 --idempotency cdf-backfill-W20-W34
```

Backfill endpoints are inclusive completed `YYYY-W##` weeks. A request is capped at 64 weeks, resolves oldest-to-newest into one durable batch, and gives every week an independent collect→audit graph. Auth/browser/publication locks serialize provider access. `collect retry <batch-id>` requeues only failed or cancelled work; successful weeks remain complete. Add `--mode refresh` only for an explicit re-collection request. No command in this component searches or presents CDF database rows.

`verify` syntax-checks the plugin, executes the focused fixture suite, validates the manager specification and disabled polling window, proves exact-week and idempotent multi-week backfill previews, and proves the August 25 opening freezes exactly two `2026-W34` tasks: collect followed by audit. It also verifies the 15-minute availability-only retry policy and Wednesday cutoff.

## Security boundary

- The worker receives only an Auth Broker profile identifier, never credentials.
- Collection input cannot supply a URL, command, environment, source path, cookie, or browser endpoint.
- Staging and artifacts are owner-private.
- Receipts contain aggregate counts, state, and stable errors only.
- Raw CDF rows, feedback, tracking IDs, names, provider IDs, hashes, private paths, and source bodies do not cross the manager receipt boundary.
- Live collection must use a dynamic Auth Broker lease; fixed port `9222` is forbidden.
- Live browser transfer is capped at 2 MiB for the authoritative CSV and 1 MiB for auxiliary provider data so CDP frames remain bounded. Larger authoritative reports fail explicitly rather than being truncated.

See [the collection data contract](references/data-contract.md) and the central plugin document.
