# Rust BrowserOS worker

DSP Paycom authentication and collection use the Rust BrowserOS driver in
`backend/src/core/browsers/paycom/`. The platform runs deterministic login and
collection scripts with no AI service. Legacy Dispatch and Hermes retain their
installations, services, and profiles.

## Installation

`tooling/browseros-release.json` pins the upstream Linux x86_64 Debian asset, its
SHA-256 digest, size, and source commit. `install-browseros.py` verifies the download
before extracting it into `/opt/dispatch-browseros/<version>/`. It does not run
package maintainer scripts or register desktop apps or services. It refuses to
overwrite an installation and records installed file hashes.

The runtime excludes the bundled agent server (including Bun), desktop extensions,
and ChromeDriver. BrowserOS control is built into the browser. The Rust launcher
also disables the managed server, server updater, extension loader, and background
updates. BrowserOS remains a Chromium fork; its binary is installed separately
from Dispatch's artifact. No upstream Rust source is copied into Dispatch.
[Upstream source and licensing](https://github.com/browseros-ai/BrowserOS/tree/96ff75aa8f3f023c526308df32cdd299331a3ec9).

On Linux x86_64 with the pinned Rust toolchain, bubblewrap, Xvfb, libX11/libXtst, and Chromium
system libraries installed:

```bash
sudo python3 tooling/install-browseros.py
npm run test:browseros
```

The check uses the root-owned `/usr/local/libexec/dispatch-dev/bwrap` launcher;
`DISPATCH_BWRAP_EXECUTABLE` can select another trusted launcher. Ubuntu hosts that
restrict nested user namespaces need `tooling/host/dispatch-dev-bwrap.apparmor`.
CI installs this profile on its disposable runner and runs the host checks during
full validation. Merge validation still builds a fresh artifact and runs the
platform smoke check when it reuses the exact PR tree's successful full checks.

## Runtime design

`backend/src/core/browsers/browseros/` owns four pieces:

- **Runtime and sessions:** the DSP manager enforces a shared browser
  capacity limit. Each session has one actor, one active command, and at most eight
  queued commands. Commands are limited to 64 KiB, CDP frames to 8 MiB, and command
  deadlines to 15 seconds including queue time. Ready DSP sessions close after 60 idle
  seconds. The worker allows up to ten minutes for manual verification; total
  lifetime is capped at 30 minutes.
- **Persistent profiles:** trusted host code derives a dedicated BrowserOS path
  from the DSP registry, such as `state/browsers/paycom-browseros`. Never accept a
  path from a DSP request or reuse a legacy browser's profile. An exclusive OS
  file lock beside the profile prevents simultaneous use, including across runtime
  instances. The lock and capacity permit remain held until the supervisor is
  reaped. Profiles survive worker restart; disposable run directories do not.
- **Sandbox and egress:** bubblewrap gives the worker private mount, PID, user,
  network, IPC, and UTS namespaces. Only its profile is writable from host storage.
  The egress socket and executables are mounted read-only. Host home directories,
  platform databases, credentials, sibling DSP profiles, and the profile lock are
  not mounted. A bounded Rust TCP-to-Unix bridge reaches the existing host egress
  proxy. Production policy permits only the existing Paycom HTTPS allowlist and
  public IPv4 destinations. Fixture policy permits only its exact synthetic host
  and port. Chromium's loopback proxy bypass and QUIC are disabled.
- **Browser control:** the hidden `browseros-worker` entrypoint runs before
  platform configuration or database initialization. It verifies its isolation,
  optionally starts a private Xvfb display, and uses the browser's inherited CDP
  pipe. The browser's debugging listener remains inside its private network
  namespace; there is no host CDP socket or raw browser-control HTTP endpoint.

Provider adapters call `Runtime::start`, then use the returned `Session` for
serialized browser commands or script evaluation. This interface is for trusted
Rust code, not user-submitted scripts. Authentication, collection, and any future
manual/agent handoff must share the same session ownership rules.

`Session::close` requests shutdown and waits for cleanup. Dropping the last handle,
abandoning startup, or losing the caller of an in-flight command also closes the
session. A canceled queued command is skipped. Transport failure or deadline expiry
retires the session so a late reply cannot be mistaken for another command's result.
The supervisor allows three seconds for normal shutdown, then kills and reaps the
namespace if necessary. Callers can inspect the returned shutdown result and use
`wait_closed` to observe automatic termination.

## Verification

`backend/tests/browseros_host.rs` runs the actual backend worker binary against
real BrowserOS with synthetic HTTP fixtures and temporary DSP directories. The
wrapper enables these otherwise ignored host tests; ordinary Rust tests include
the bounded CDP transport checks. Test state is removed after completion.

The host checks cover:

- Concurrent DSPs with separate namespaces, profiles, cookies, and local storage.
- Exact scripted input, form submission, extraction, and PNG screenshots in
  headless and windowed modes, with Chromium's internal sandbox enabled.
- Cookie/local-storage persistence across graceful restart and profile locking
  across independent runtime instances.
- Allowed fixture traffic and denial of host loopback and other fixture ports.
- Capacity exhaustion, oversized commands, queue saturation, command deadlines,
  caller cancellation, failed/abandoned startup, and dropping the last handle.
- Normal and forced shutdown, disappearance of descendant processes, released
  profile leases, cleaned run directories, and successful restart.
- A process allowlist containing only Rust, bubblewrap, BrowserOS and optional
  Xvfb, with no Node/Bun or agent server in the worker namespace.

The API checks in `tests/paycom-worker.test.ts` and `tests/native-browser.test.ts`
exercise native X11 PIN input, rejection cooldowns across restart, explicit CAPTCHA
continuation, cookie reuse, complete roster/timecard collection, separate DSPs,
and preservation of the prior publication when a roster or total is incomplete.
They also prove that at most two timecard document requests overlap, an odd-sized
roster completes, cross-employee responses fail, throttling schedules backoff, and
cancelling a job closes both in-flight pages.
They run as part of `npm run test:browseros` during full CI checks. Synthetic results
do not establish real provider latency or measured memory savings.

## Paycom driver

The driver opens the existing landing session before submitting credentials.
Numbered PINs use native X11 events on a private display, preserving spaces and
leading zeroes. Pointer events locate BrowserOS's content area before native
clicks; asymmetric browser controls cannot shift the submit target. Page scripts
run in isolated JavaScript worlds and validate the exact provider origin, route,
form and known layout. The platform API exposes bounded assistance actions only.

The host stores attempt state and sanitized diagnostics beside the profile,
outside the browser mount. Rejections impose five-minute and thirty-minute
cooldowns; a third rejection requires manual intervention. Interrupted submissions
permit observation-only recovery, preventing an automatic credential replay.
Manual CAPTCHA assistance requires an explicit Submit action; retained PINs can
only be submitted again in the same document with the same values.

Collection closes credential tabs, captures the Timecard Search roster request,
selects the current fortnight using the DSP timezone, and verifies exact employee
membership. It validates each timecard's identity, dates, layout and weekly totals
before Rust reconciles daily hours. Two tabs load timecards in bounded pairs within
the same browser and DSP session. Each tab owns its execution-context cache. A
scripted navigation releases the serialized command channel while Paycom responds;
the reader then requires a new document, the exact employee URL, a fully loaded
table and all existing validation. Collection replaces each tab's history entry so
completed employee pages cannot accumulate in the back/forward cache. Credentials
remain confined to authentication.
Throttling or server errors abort the pair and use the existing bounded job retry
backoff. Failed or cancelled jobs preserve the last
successful publication. One persistent browser serves the flow without a Node
worker, Playwright connection, or second browser launch.

`DISPATCH_BROWSEROS_EXECUTABLE` defaults to the pinned installation. The legacy
`DISPATCH_BROWSER_EXECUTABLE` setting does not select the DSP provider browser.
The artifact still includes archived Node worker files for compatibility with the
existing artifact inventory/updater; DSP authentication and collection do not run
them. Removing those files requires a coordinated artifact/updater change.

## Live collection measurements

An ignored operator benchmark can collect from an explicitly selected, idle DSP
without publishing the result. It uses that DSP's saved credentials and profile,
compares daily records with the active publication, and prints only aggregate
timing, counts and process-tree RSS. Live provider changes may produce differences;
the benchmark re-reads changed employees through the original sequential path and
fails if those fresh records disagree. RSS sums shared
pages across processes and is not a measure of unique physical memory.

```bash
DISPATCH_BENCHMARK_DSP=/absolute/environment/dsps/dsp_selected \
DISPATCH_BENCHMARK_WORKER=/absolute/environment/live/.build/services/rust/dispatch-backend \
DISPATCH_BENCHMARK_RUNS=/absolute/private/temporary-runs \
DISPATCH_BENCHMARK_TIMEZONE=UTC \
cargo test --locked --lib measure_live_collection -- --ignored --nocapture
```

Use the DSP's configured timezone. The profile lease rejects concurrent use of
that same profile. The benchmark does not solve CAPTCHA or change credentials;
an authentication challenge stops the measurement. Remove its empty runs directory
afterward. Full API job timings include authentication and publication overhead
that this collector-only measurement excludes.

## Remaining work

- Extend real-provider acceptance to additional DSP account variants.
- Remove the unused Node worker artifact payload through an updater-compatible change.
- If requested, add a separately enabled MCP gateway with DSP authorization and
  exclusive control handoffs between scripts, humans, and optional agents.
