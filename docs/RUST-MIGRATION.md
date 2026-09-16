# Rust platform core

## Scope

The Node platform core is retired. One Rust executable serves the HTTP API and
static React dashboard and owns accounts, sessions, authorization, DSP lifecycle,
credential encryption, browser orchestration, jobs, schedules, mail, audit,
workforce publication, backup and restore. Systemd starts it directly on loopback.
The Node API, Preview gateway, supervisor, platform services and deployed Node CLI
are removed from both source and build artifacts.

Paycom authentication and collection now run through the Rust BrowserOS driver.
The browser has a private profile, display, nested sandbox and inherited CDP pipe.
Ready sessions close after 60 idle seconds; native PIN input, cooldowns and manual
verification are covered by real BrowserOS fixture tests. See [BrowserOS](BROWSEROS.md).
Node remains a frontend/build/test dependency. Archived Node worker files remain
in the artifact for updater compatibility but are not used by DSP provider jobs.

## Runtime

- Axum/Tokio handles HTTP, worker I/O, deadlines and cancellation.
- Four blocking database workers have a 64-operation admission bound and a
  two-second admission timeout. Reads can overlap; state transitions serialize.
- Reused SQLite connections use WAL, full synchronous durability, prepared
  statements and bounded page caches. A worker caches at most four DSP databases.
- Employee filtering, Unicode collation and pagination run in SQLite. Timecard
  ordering borrows values instead of cloning punch arrays during comparisons.
- Argon2id password verification runs outside the database transition lock and
  admits at most two simultaneous verifications. Sessions and signed DSP views
  revalidate account and membership versions on every request.
- Browser capacity is two per environment, with at most 32 queued commands per
  session. Authority is checked again after a command waits. Revision-aware
  cleanup prevents an old job from closing a newer connection.
- Collection validates the complete dataset and commits a publication atomically.
  Cancellation, suspension, revoked authority and credential changes prevent late
  publication. Startup recovers jobs before serving requests and removes orphan
  ephemeral browser runs while holding the environment lock. An essential
  background task failure shuts down the core so systemd can restart it.

Private directories require mode 0700 and files have private modes. The core
rejects symlinks, hardlinks and incompatible account schema versions. The account
database is version 3; provider secrets use a new authenticated-encryption binding.
A Node state directory cannot be opened as a Rust platform accidentally.

## Artifact and operations

`npm run build` produces a format-2, schema-3 artifact containing:

```text
services/rust/dispatch-backend
services/runtime/auth-worker.js
services/runtime/collection-worker.js
services/runtime/provider/
dashboard/
node_modules/                     Playwright and Zod for isolated workers
package.json / package-lock.json
tooling/build-info.json
release.json                     Full inventory, source metadata and digest
```

The external Python updater verifies the exact successful merged-dev artifact,
restores executable permissions after extraction, and rolls back compatible code
on startup failure. The initial Node-to-Rust transition requires the explicitly
authorized [fresh Dev cutover](DEV-SETUP.md#fresh-state-cutover-from-the-node-core).
It bootstraps and verifies a new owner and empty permanent Dev DSP before erasing
old state. Archive, Production and unrelated configuration remain outside its scope.

Installed operational commands are direct Rust commands. Load the appropriate
private environment first:

```text
dispatch-backend serve
dispatch-backend bootstrap EMAIL FIRST LAST < private-password-file
dispatch-backend status
dispatch-backend backup /absolute/private/backup
dispatch-backend restore /absolute/private/backup /absolute/empty/target
```

Bootstrap accepts a password only through stdin. Backup requires the serving
process to be stopped; the exclusive environment lock prevents mixed snapshots.
Restore verifies checksums and revokes web capabilities and pending jobs. Status
uses a read-only database connection and works while the service is running.

## Verification

Rust unit/integration tests cover crypto binding, storage permissions, incompatible
schema refusal, publication validation/atomicity, queue limits, authority changes,
DST scheduling and the actual egress proxy. TypeScript tests exercise a real Rust
TCP server for onboarding, sessions, roles, invitations, password recovery,
credential verification, jobs, cancellation, recovery, workforce settings,
Unicode ordering, database contention, backup and independent platform isolation.

The installed artifact test checks a fresh owner login, empty DSP, dashboard,
release digest and the absence of a Node core process or entrypoint. Python tests
cover immutable artifacts, dirty checkout protection, normal Rust code rollback
and fresh-state reset recovery. Existing dashboard tests run against the built
Rust artifact. Native tests exercise the real isolated worker and local provider
fixtures, including CAPTCHA assistance, PIN handling and collection. Host checks
verify nested namespaces, seccomp and native OS input.

Legacy gateway and pilot socket tests were replaced by direct Rust API and
external-updater tests. Their production features were removed, not retained as a
fallback. Real Paycom account behavior still requires testing with the owner's
credentials; synthetic/native fixture results do not measure provider latency.

## Reproduce the performance comparison

```bash
DISPATCH_BENCHMARK_BASELINE=/absolute/previous-node-artifact npm run benchmark:rust
```

The baseline path supplies code only. The script creates separate temporary state,
seeds 3,000 employees and 90,000 timecards identically in both implementations, and
uses real local TCP requests with login and signed DSP views. Each concurrency
level runs 240 requests across employee list/search/detail, daily timecards and
session routes. Response content is validated throughout. Memory includes each
core process and descendants; Chromium and provider networking are excluded.
Temporary state and processes are removed at completion.

Measurements are stored in [core-benchmark.json](core-benchmark.json). They describe
one Linux host and a synthetic workload; they are not production capacity limits.
Rust lowers baseline memory and supports overlapping reads, but horizontal scaling
still requires a design for shared state, distributed job ownership and tenant
placement. SQLite remains local to each independent platform.

Measured on the local Linux host (decimal MB):

| Metric                                  | Previous Node core | Rust core |
| --------------------------------------- | -----------------: | --------: |
| Idle core + descendants                 |           187.3 MB |   11.3 MB |
| Peak during workload                    |           276.2 MB |   94.2 MB |
| Throughput, 16 concurrent requests      |           35 req/s | 156 req/s |
| p95 latency, 16 concurrent requests     |         1224.05 ms | 174.42 ms |
| Errors across all 960 measured requests |                  0 |         0 |
