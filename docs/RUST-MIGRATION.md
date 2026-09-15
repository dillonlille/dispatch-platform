# Rust backend migration

## First slice

Employee detail (`GET /api/dsp/employees/:code`) now reads through the Rust
`dispatch-backend` executable. The React dashboard and public response contract
are unchanged. The Fastify gateway checks the session and signed DSP view before
calling Rust, then rechecks permission before returning the asynchronous result.

Rust uses Axum/Tokio for a private HTTP service and rusqlite with bundled SQLite.
Each API runtime owns one child process and a Unix socket in a private temporary
directory (0700 directory, 0600 socket). Rust opens no TCP listener. The gateway
passes a validated DSP identity and employee code, never a request-supplied path.
This socket is a trusted internal interface: possession of the Unix account's
permissions grants access; it is not a public authenticated API.

SQLite connections are read-only and use a transaction to read preferences, the
latest publication containing that employee, and its timecards consistently.
The existing TypeScript publisher remains the sole writer. Schema version 1 is
required; unsupported schemas fail closed. Tenant path checks reject symlinks,
hardlinked database files and non-private permissions. Browser namespaces and
credential vault access are unchanged.

Blocking database work runs outside Tokio's HTTP threads with at most eight
concurrent database reads. The gateway admits at most 32 pending calls, with a
five-second deadline and a 16 MiB response ceiling. Overload/unavailability returns 503. Database errors return a generic 500 without private details. Readiness requires
the Rust protocol health check; a missing or unusable executable fails startup and
therefore the existing deployment health check. A crashed process can restart on
the next request after a one-second cooldown. There is no silent TypeScript fallback.
Shutdown closes the pipe and terminates the child, escalating after two seconds.
The child also exits when its parent pipe disappears unexpectedly.

The TypeScript employee reader remains as a compatibility oracle for tests and
benchmarks. Employee lists, daily timecards, accounts, jobs, publication, credential
handling and browser workers have not migrated yet.

## Build and verification

Install Rust with rustup and add its `bin` directory to PATH. `rust-toolchain.toml`
pins the compiler, formatter and Clippy; commit Cargo.lock. Linux and a C compiler
are required for this initial native build. CI builds on Ubuntu 24.04 x86_64; the
artifact requires a compatible Linux x86_64 host with glibc 2.39 or newer. Other
architectures need their own verified artifact.

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm test
npm run build
npm run test:artifact
npm run test:ui
```

`npm test` and `npm run dev` build the debug executable first. `npm run build`
compiles a release executable into `.build/services/rust/dispatch-backend` and
includes it in the existing SHA-256 inventory. Installed environments need no Rust
toolchain. After verified archive extraction, the bundled gateway restores owner
execute permission on that specific binary; tar-supplied permissions remain ignored.
The database and artifact formats do not change, allowing code rollback.

Tests compare real Rust HTTP results with the existing reader, including historical
publications, Unicode names, inactive employees, timecard ordering and multiple
DSPs. They exercise authentication, permission revocation during a read, unsafe
paths, incompatible schemas, missing executables, child crashes and parent loss.
The artifact test checks the built endpoint and rollback after a broken Rust binary.

Run `npm run benchmark:rust` for a repeatable synthetic microbenchmark. It compares
direct TypeScript reads with Rust calls including Unix HTTP overhead, checks response
equality, and reports latency plus the Rust process's resident memory before/after
500 reads. The Node harness measurement includes fixtures and test tooling.
It does not measure browser collection memory or predict whole-platform savings.

**This phase adds a Rust process while Node still runs the platform, so total idle
memory may increase.** Lower overall memory becomes a measurable objective as more
services migrate and the Node core can be removed. No savings percentage is claimed.

## Next slices

1. Move employee lists and daily timecards, preserving preferences, pagination,
   locale-sensitive sorting and historical-publication behavior with parity tests.
2. Move queue claiming, scheduling, cancellation and recovery, with one authoritative
   scheduler and writer at each cutover. Test crashes and credential-generation changes.
3. Move accounts, sessions, DSP authorization, audit and the public gateway. Preserve
   existing session/credential formats or explicitly plan their transition.
4. Move publication and operational tooling, then retire the Node core. Keep the
   isolated Node/Playwright provider workers until there is a measured reason to port them.

At each cutover, compare representative idle/load memory, p95 latency, failures and
long-running recovery behavior in Dev. Keep SQLite and private-state layout stable
until a separate storage decision is justified by measured contention or scale.
