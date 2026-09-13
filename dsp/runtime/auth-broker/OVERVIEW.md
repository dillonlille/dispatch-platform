---
title: Auth Broker overview
status: current
last_verified: 2026-09-02
---

# Dispatch Auth Broker

The Auth Broker is the credential-storage and authenticated-session boundary for Dispatch collectors. It is intentionally independent of Paycom roster and timecard business logic.

## Current capability

Version `0.9.0` provides a working local broker core, automated credential-free recovery for interrupted Paycom submissions, a live-accepted Paycom handoff, and a fixture-verified Amazon Logistics adapter boundary:

- AES-256-GCM encrypted credential profiles;
- a separate 256-bit master key;
- strict Paycom, Amazon Logistics, and HTTP-basic credential schemas;
- owner-only database, key, state directory, and Unix socket permissions;
- local hidden-terminal enrollment and replacement;
- metadata `health`, `providers`, `list`, `status`, `lock`, and `unlock` socket operations;
- durable pre-submission attempt latches, phase-specific cooldowns, reasoned manual states, and credential-free observation recovery after approved local interruptions;
- broker-owned, provider/profile-scoped persistent Paycom and Amazon Logistics browser state and private Chrome processes;
- a Paycom authentication adapter that performs credential and exact indexed-PIN entry inside the broker;
- an Amazon Logistics adapter that recognizes exact approved application/sign-in origins and routes, an exact return target, both combined and separate username/password forms, conservative sign-out and `/performance` capability evidence, MFA, CAPTCHA, security challenges, account lockout, invalid credentials, and ambiguous layouts;
- short-lived browser leases bound to an auth profile, collector ID, and Collection Manager run ID;
- full loopback CDP handoff to the plugin only after authentication succeeds;
- integrity verification that decrypts and authenticates every stored profile;
- no public credential-read or export operation.

The Paycom plugin controls the browser completely after handoff. The broker does not constrain plugin navigation, JavaScript, network access, tabs, downloads, uploads, or collection strategy. Because full CDP access includes authenticated cookies and storage, installed plugins are trusted with the resulting session. They still never receive the vault credential object.

The Paycom adapter has crossed a supervised provider-login and protected-application handoff boundary. Current profile enrollment, browser state, and provider readiness remain installation-local and must be queried through the metadata-only status interface.

The Amazon Logistics adapter has fixture acceptance only. It has not completed the separate supervised live-login and lease acceptance gate. Repository documentation intentionally records no installation's profile inventory, latch state, credential roots, or migration candidates.

## Paths

```text
Database: <data-root>/auth-broker/credentials.sqlite3
Master key: <secrets-root>/auth-broker/master.key
Socket: <runtime-root>/auth-broker.sock
Browser state: <state-root>/auth-broker/browser-sessions/
Attempt state: <state-root>/auth-broker/authentication-attempts.json
```

`DISPATCH_LOCAL_ROOT` derives external development storage. Without it, new installations use XDG roots. `DISPATCH_DATA_ROOT`, `DISPATCH_SECRETS_ROOT`, `DISPATCH_STATE_ROOT`, and `DISPATCH_RUNTIME_ROOT` or explicit local SDK runtime options may override those defaults. `resolveLocalRuntimePaths()` rejects mutable roots inside the source worktree.

The database directory is mode `0700`; the database, key, and live socket are mode `0600`. See [`SECURITY.md`](SECURITY.md) for the explicit threat model, guarantees, limitations, and production-hardening requirements.

## Safe Paycom credential setup

For the legacy/local terminal workflow, stop the Auth Broker before changing credentials, then run the dedicated interactive command from a private local terminal:

```bash
./bin/dispatch-paycom-credentials enroll
```

This defaults to profile `paycom-main`. To use another non-secret profile identifier:

```bash
./bin/dispatch-paycom-credentials enroll paycom-backup
```

The wizard reads the Paycom client code, username, password, and five security-PIN answers directly from `/dev/tty`. Terminal echo is disabled, every value must be entered twice, and no credential value is accepted through arguments, environment variables, redirected standard input, or ordinary files. The command returns profile metadata only.

Replace the existing `paycom-main` profile with:

```bash
./bin/dispatch-paycom-credentials replace
```

Replacement securely resets the profile's persistent Paycom browser/device state before committing the new encrypted credential record. Removal deletes both the encrypted record and its persistent browser state. Ordinary browser release and broker restart terminate Chrome but retain the owner-private Paycom device profile.

## Amazon Logistics credential preparation

The registered provider ID is `amazon-logistics`; the intended non-secret profile ID is `amazon-operations`. The unified protected workflow can enroll and optionally test it from the project root:

```bash
./bin/dispatch setup auth --provider amazon-logistics --profile amazon-operations --test-auth
```

Do not run that command through chat, redirected input, screen sharing, or automation. It stops and restores only the verified managed broker, reads username and password twice from `/dev/tty` with echo disabled, and returns metadata only. The strict adapter recognizes approved login forms and challenge categories in fixture coverage; every live challenge, latch, and continuation decision remains installation-local and fail-closed. The lower-level offline admin remains available for recovery when the managed workflow cannot be used.

Verify metadata and vault integrity without revealing credentials:

```bash
./runtime/auth-broker/bin/dispatch-auth-broker-admin status amazon-operations
./runtime/auth-broker/bin/dispatch-auth-broker-admin verify
```

Then restart the broker for a separately supervised fixture-to-live acceptance. `broker_running`, `tty_unavailable`, or `confirmation_mismatch` are safe failures: no credential profile is changed.

## General administration

Initialize the vault:

```bash
./runtime/auth-broker/bin/dispatch-auth-broker-admin init
```

The provider-generic equivalent of the Paycom enrollment wizard is:

```bash
./runtime/auth-broker/bin/dispatch-auth-broker-admin enroll paycom-main paycom
```

For the fixture-registered Amazon provider, the equivalent is:

```bash
./runtime/auth-broker/bin/dispatch-auth-broker-admin enroll amazon-operations amazon-logistics
```

Metadata-only operations:

```bash
./runtime/auth-broker/bin/dispatch-auth-broker-admin list
./runtime/auth-broker/bin/dispatch-auth-broker-admin status paycom-main
./runtime/auth-broker/bin/dispatch-auth-broker-admin verify
./runtime/auth-broker/bin/dispatch-auth-broker-admin remove paycom-main
```

There is intentionally no command that displays or exports credentials.

## Broker service

Start in the foreground:

```bash
./tooling/start
```

Use the socket client from another terminal:

```bash
./bin/dispatch-auth-brokerctl health
./bin/dispatch-auth-brokerctl providers
./bin/dispatch-auth-brokerctl list
./bin/dispatch-auth-brokerctl status paycom-main
./bin/dispatch-auth-brokerctl lock paycom-main
./bin/dispatch-auth-brokerctl unlock paycom-main
./bin/dispatch-auth-brokerctl test-auth-profile paycom-main
```

`unlock` clears an operator lock or non-recoverable attempt latch. Use it only after locally reviewing the provider account state; it never reveals or changes credential values. Interrupted submitted Paycom attempts do not call `unlock`: the broker may recover them automatically only by proving an existing exact authenticated Timecard Search session without reading or submitting credentials/PINs.

Each connection accepts one newline-terminated JSON request of at most 4096 bytes and returns one bounded JSON response. The socket is owner-only and stale sockets are removed only after ownership, type, and liveness checks.

## Plugin browser API

Plugins should use `src/browser-client.js` programmatically so lease values do not appear in command arguments:

```js
const { acquireAuthenticatedBrowser } = require('./src/browser-client');

const lease = await acquireAuthenticatedBrowser({
  profile: 'paycom-main',
  collector: 'paycom',
  runId: 'run-from-collection-manager',
  ttlSeconds: 900,
});

try {
  // Connect Playwright/Puppeteer/CDP to lease.endpoint.
  // access is deliberately "full".
} finally {
  await lease.release();
}
```

Protocol version `5` includes the metadata-only `test-auth-profile` and credential-free `inspect-auth-profile` operations plus the browser operations `acquire-browser`, `browser-status`, `renew-browser`, and `release-browser`. They are strict JSON operations, not arbitrary browser commands. Test/inspection operations expose no lease or endpoint, and the authentication test destroys its browser before returning. The endpoint returned by `acquire-browser` gives the trusted plugin full CDP control. A plugin may renew within the 30–3600 second policy window. Lease expiry, release, profile locking, and broker shutdown terminate Chrome. Paycom and Amazon Logistics owner-private device profiles persist for their bound auth profiles; ephemeral profiles used by other providers are removed.

The browser client converts socket absence, refusal, and other local transport details into the stable `broker_unavailable` code. Acquisition deadline expiry becomes `authentication_timeout`, and cancellation remains `acquisition_cancelled`. Collectors therefore receive actionable sanitized failures rather than operating-system socket errors or a generic collection failure.

A hardened user-service template is provided at `integration/systemd/dispatch-auth-broker.service.in`. Render the Dispatch user-service units for the current checkout and an external local-data root with `core/tooling/render-systemd-units --local-root <absolute-local-root> --output-dir <absolute-unit-directory>`. It uses `KillMode=control-group` so Chrome and all descendants are terminated with the broker, and `Restart=always` so unexpected clean exits are recovered. The template is not installed or enabled automatically.

The current local setup workflow instead uses a fixed-operation lifecycle adapter with a private service record and a reviewed Linux pidfd signal helper. Broker startup and credential mutation share an exclusive maintenance lock so the broker cannot start during vault replacement.

## Development checks

```bash
./tooling/test
./tooling/build
./tooling/verify
```

The test suite uses temporary vaults with non-production fixtures. It verifies encryption, tamper rejection, strict schemas, private permissions, socket behavior, provider route classification, persistent-profile policy, attempt-format migration, interruption classification, credential-free recovery, no-resubmission failure behavior, cooldown/manual/operator-lock preservation, browser cleanup, and credential scrubbing. Fixture success is not live Amazon acceptance.

Managed OCI runtimes additionally accept the fixed private `enroll-paycom` operation from their Gateway, enabled only in the fixed container environment. It binds `paycom-main`, requires create/replace intent, drains the profile session and writes through the encrypted vault. There is no credential-read response. The dashboard owner workflow and deployment prerequisites are described in DSP acceptance.

### Paycom failure diagnostics and retry readiness

`dispatch-auth-brokerctl profile-readiness paycom-main` reads the current recovery state and the last sanitized failure trail without launching Chrome, decrypting credentials, or submitting a login. States distinguish readiness, observation-only recovery, cooldown (with `retryAt`), manual review, busy work, and a missing profile. A readiness response never clears the attempt guard.

The broker retains at most eight observations per profile in private `authentication-diagnostics.json` under the Auth Broker state directory. It survives broker restart, is replaced by a later failed attempt, and is cleared after successful authentication or managed credential replacement. Paycom observations include numbered challenge indices, form counts, the recognized challenge action path, and a closed reason code such as `additional_verification`, `ambiguous_rejection`, `challenge_layout_changed`, or `challenge_response_timeout`. Page text, input values, query values, titles, and CDP messages are excluded. This file is diagnostic evidence, not permission to retry.

The owner's Paycom page checks current readiness for failed requests and again before accepting Retry connection. Cooldowns and busy/unavailable states refresh automatically; manual blocks require review. The setup form requires the original Paycom security PIN numbering (1–5).
