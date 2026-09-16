# Rust BrowserOS worker

The BrowserOS runtime now lives in the Rust backend, replacing the standalone
proof program. It ships in the normal artifact and can be used by internal
provider adapters. **The current Paycom driver still uses the existing Node
workers.** Authentication and collection must be ported before selecting this
runtime for provider jobs. Legacy Dispatch and Hermes retain their installations,
services, and profiles.

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

On Linux x86_64 with the pinned Rust toolchain, bubblewrap, Xvfb, and Chromium
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

- **Runtime and sessions:** one runtime per environment supplies a shared browser
  capacity limit. Each session has one actor, one active command, and at most eight
  queued commands. Commands are limited to 64 KiB, CDP frames to 8 MiB, and command
  deadlines to 15 seconds including queue time. Idle sessions close after 60
  seconds; total lifetime is capped at 30 minutes.
- **Persistent profiles:** trusted host code derives a dedicated BrowserOS path
  from the DSP registry, such as `state/browsers/browseros/paycom`. Never accept a
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

These are synthetic functional checks, not Paycom performance benchmarks. They do
not establish native X11 keyboard compatibility or a measured memory/speed gain.

## Remaining migration work

1. Port Paycom authentication, PIN handling, cooldowns, recovery, and manual
   assistance to this runtime. Verify the native input behavior required by the
   retained authentication flow, then wire the adapter into the Rust session manager.
2. Port collection, verify workforce/timecard parity and atomic publication, and
   select the Rust worker for real provider jobs.
3. Add a separately enabled MCP gateway with authorized session scope and exclusive
   control handoffs between scripts, humans, and optional agents.
4. Benchmark complete collection and recovery, then retire the platform's remaining
   Node browser workers. Shared legacy Dispatch/Hermes tooling stays independent.
