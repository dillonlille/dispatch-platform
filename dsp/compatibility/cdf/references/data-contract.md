---
title: CDF collection data contract
status: current
last_verified: 2026-08-29
---

# CDF collection data contract

## Reporting week

A collection request names one exact `YYYY-W##` week. CDF source weeks run Sunday through Saturday. The label is the ISO week obtained after shifting a source delivery date forward by one day.

A target is completed only when its Saturday end date is earlier than the current date in the configured source timezone.

Publication time is not report identity. For example, the Tuesday, August 25 through Wednesday, August 26, 2026 polling campaign resolves `latest-complete` once to `2026-W34`, covering Sunday, August 16 through Saturday, August 22. Every 15-minute attempt retains that exact target; the Wednesday posting time never changes artifact identity.

## Live weekly source boundary

The production source uses one dynamic Auth Broker lease and fixed code-owned Amazon Logistics routes. Manager input cannot supply a URL, JavaScript expression, download location, browser endpoint, or source path.

Before source bytes are accepted, the adapter requires:

- the exact feedback page query for week, station, and company;
- visible evidence for the requested week;
- exactly one matching CDF-negative CSV download link;
- an approved HTTPS Logistics/S3 download location;
- an approved CSV content type;
- a bounded streaming body no larger than 2 MiB.

The auxiliary provider operation uses exact week/station/DSP API query fields and a 1 MiB bounded JSON response. Any provider operation or normalization failure becomes unavailable/degraded evidence; unvalidated provider bytes are never published.

Authentication, CAPTCHA, challenge, unavailable-week, wrong-page, timeout, content-type, oversize, cancellation, and cleanup conditions remain distinct closed states. The lease is renewed while active and released on every normal success/failure path.

## Authoritative CSV

The CDF-negative CSV is authoritative. It must be bounded UTF-8 CSV, not HTML, and must match one exact header schema.

### `cdf-negative-v1`

1. `Delivery Group ID`
2. `Delivery Associate`
3. `Delivery Associate Name`
4. `DA Mishandled Package`
5. `DA was Unprofessional`
6. `DA did not follow my delivery instructions`
7. `Delivered to Wrong Address`
8. `Never Received Delivery`
9. `Received Wrong Item`
10. `Feedback Details`
11. `Tracking ID`
12. `Delivery Date`

### `cdf-negative-v2`

Same as v1, with `Impacts Scorecard` between `Delivery Associate Name` and the six complaint columns.

### `cdf-negative-v3`

1. `Delivery Group ID`
2. `Delivery Associate`
3. `Delivery Associate Name`
4. `Impacts Scorecard`
5. `Tracking ID`
6. the six complaint columns in the v1 order
7. `Feedback Details`
8. `Dispute status`
9. `Delivery Date`

Every data row must:

- have the exact schema width;
- contain non-empty delivery-group, delivery-associate, and tracking identities;
- use only `0` or `1` in all six complaint columns;
- contain a valid `YYYY-MM-DD HH:MM:SS` delivery timestamp, optionally with fractional seconds;
- bind to the requested reporting week.

A header-only CSV is a valid imported zero-complaint week. It is distinct from an unavailable week and from invalid/empty source bytes.

## Auxiliary provider links

The provider-link artifact is JSON:

```json
{
  "contract_version": 1,
  "week": "2026-W20",
  "rows": [
    {
      "da_name": "Fixture Driver",
      "transporter_id": "transporter-1",
      "provider_id": "amzn1.flex.provider.v1.12345678"
    }
  ]
}
```

The contract rejects unknown fields, wrong weeks, empty identities, malformed Amazon provider IDs, and duplicate transporter/provider pairs.

Provider links are auxiliary. If their source is unavailable, collection publishes a canonical empty week-bound provider artifact with manifest status `degraded` and a sanitized warning. A malformed artifact that claims to be collected fails validation; the live source adapter is responsible for mapping a provider-link collection failure to unavailable rather than passing corrupt bytes.

## Manifest and identity

Each publication contains:

- contract version;
- exact week, station, company identity, and DSP identity;
- collection time, run ID, and attempt;
- source schema, byte count, row count, column count, and SHA-256;
- provider status, byte count, row count, and SHA-256;
- a content identity digest;
- a canonical manifest digest.

The collection digest excludes execution metadata and is derived from the week, station, source identity, and provider identity. Recollecting identical artifacts therefore returns `no_change` even when run/time metadata differs.

## Publication semantics

- New week with valid artifacts: `published`.
- Same active content: `no_change`.
- Different content for an active week without `replace: true`: `week_already_loaded`.
- Different valid content with explicit replacement: publish a new immutable directory and transactionally advance the active pointer.
- Any validation, hash, staging, database, or audit failure: do not advance the active pointer.

Prior immutable collection records remain available as rollback evidence. Search/read projections are deliberately outside this contract.

## Receipt boundary

Allowed collection receipt data is aggregate only:

- method;
- target week;
- source row and column counts;
- provider-link count and `ready`/`degraded` status;
- verification boolean;
- closed warnings and errors.

Receipts do not expose source rows, feedback, identities, provider IDs, filenames, hashes, artifact/database paths, browser endpoints, cookies, credentials, or raw provider errors.
