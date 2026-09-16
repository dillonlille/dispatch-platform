# BrowserOS runtime proof

The first migration milestone is an opt-in Rust host check. The deployed Paycom
driver remains unchanged. Legacy Dispatch and Hermes retain their existing Chrome
installations, services, and profiles.

## What is installed

`tooling/browseros-release.json` pins the upstream Linux x86_64 Debian asset, its
GitHub SHA-256 digest, size, and source commit. `install-browseros.py` verifies the
download before extracting it into `/opt/dispatch-browseros/<version>/`. It does
not run package maintainer scripts or register a browser, service, or desktop app.
It refuses to overwrite an existing installation and records file hashes in
`dispatch-install.json`.

The extracted runtime excludes the bundled agent server (including Bun), desktop
extensions, and ChromeDriver. BrowserOS control commands are implemented in the
browser itself. The launcher additionally disables the managed server, extension
loader, server updater, and background updates.

BrowserOS remains a Chromium fork. The upstream browser is independently installed
software; it is not included in Dispatch's release artifact. No BrowserOS Rust
source is copied into Dispatch. Upstream source and licensing remain available at
[BrowserOS](https://github.com/browseros-ai/BrowserOS/tree/96ff75aa8f3f023c526308df32cdd299331a3ec9).

## Run locally

On a Linux x86_64 host with the pinned Rust toolchain, bubblewrap, Xvfb, and Chromium
system libraries installed:

```bash
sudo python3 tooling/install-browseros.py
npm run test:browseros
```

The check uses `/usr/local/libexec/dispatch-dev/bwrap`, the dedicated root-owned
launcher configured for Dev. `DISPATCH_BWRAP_EXECUTABLE` can select another
root-owned launcher. Ubuntu hosts that restrict nested user namespaces need the
profile in `tooling/host/dispatch-dev-bwrap.apparmor`; keep Chromium's namespace and
seccomp sandboxes enabled. CI installs that profile for its disposable runner.

`npm run test:browseros` removes its own temporary profiles, screenshots and reports
after completion. To retain synthetic evidence, pass a new output directory:

```bash
cargo run --locked --example browseros_probe -- \
  /opt/dispatch-browseros/0.50.5/browseros \
  /usr/local/libexec/dispatch-dev/bwrap \
  /tmp/dispatch-browseros-report
```

The example is a verification program, not an HTTP route or a provider driver.
Full CI checks run it; reused merge validation still requires the existing fresh
artifact build and platform smoke check.

## What the proof checks

- A Rust worker and BrowserOS execute inside private mount, PID, network, IPC, and
  UTS namespaces. Host home directories and platform/DSP data are not mounted.
- Each invocation gets a new private profile. A synthetic HTTP server exists only
  inside that network namespace. External networking is unavailable.
- Rust speaks CDP over a private inherited socket pair, with bounded frames and
  command deadlines. BrowserOS-specific `Browser.createTab` and `Browser.getTabs`
  calls confirm that this is the intended browser runtime.
- Headless and Xvfb windowed runs navigate, enter exact text, click a submit
  button, read a structured fixture result, and capture a PNG.
- Input comes through browser input commands, including trusted DOM input events.
  The windowed check waits for the active page to paint before clicking.
- `chrome://sandbox` reports enabled PID/network namespaces and seccomp.
- A process-name allowlist rejects unexpected processes, including Node, Bun, and
  agent servers. No model or MCP client participates in this check.
- Normal browser close succeeds. A separate run forcibly kills and reaps the
  bubblewrap supervisor, whose PID namespace contains its descendants. Timeouts
  also terminate and reap the supervisor before removing temporary state.

The report contains timings and a snapshot of summed process RSS. Summed RSS counts
shared mappings multiple times; it is neither PSS nor peak memory. The fixture
timings are not Paycom throughput measurements or evidence of a performance gain.

## Remaining migration work

1. Turn the proven launch/transport choices into the production Rust browser worker
   with durable DSP profiles, queue limits, cancellation, and provider egress rules.
2. Port Paycom authentication, PIN handling, cooldowns, recovery, and manual
   assistance. This check's CDP input does **not** prove the native X11 keyboard
   behavior required by the retained Paycom authentication implementation.
3. Port collection and verify workforce/timecard parity and atomic publication.
4. Add a separately enabled MCP gateway, scoped to an authorized browser session,
   with exclusive control handoffs between scripts, humans, and optional agents.
5. Benchmark complete collection and recovery, then replace the current platform's
   Node workers. Shared legacy Dispatch/Hermes tooling remains independent.

No real provider credentials, imported browser sessions, persistent DSP data, or
external AI services are used by this milestone.
