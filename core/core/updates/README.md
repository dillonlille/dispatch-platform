# Independent updates

The Platform Owner Updates page uses separate Core and DSP release histories.
Only the active platform owner outside a DSP view can issue update commands.
Requests require the normal session, CSRF protection and an idempotency key. The
worker rechecks owner authority before executing a command, including after a
release download. Commands never accept an arbitrary repository or executable.

## Code and private storage

| Location | Purpose |
| --- | --- |
| `core/updates/github.js`, `extract.py` | Read published releases from the two Dispatch repositories; verify tag, main commit, hosted release-workflow provenance, archive, inventory and plugin packages. |
| `core/updates/local-releases.js` | Durable release identities, selected versions, Dev health proof, rollout and interrupted-operation journal. |
| `core/updates/commands.js`, `worker.js` | Persistent owner commands, one external worker and periodic release discovery. |
| `core/updates/directory.js`, `transport.js` | Private worker-to-API socket and DSP activation under the directory controller. |
| `host/releases/core.js`, `core-state.js` | Stop Core services, snapshot Core state, swap code, verify API/database health and recover. |
| `host/releases/dsp.js`, `runtime.js`, `runtime-package.js` | Drain one DSP, snapshot its state, copy and verify runtime files, select its installed plugins and restore that DSP on failure. |
| `host/releases/provisioning.js` | Give new DSPs the last completely rolled-out release. |
| `host/releases/setup.js`, `bin/dispatch-updates` | Configure permanent Dev, register an existing split baseline, prepare the independent worker and queue offline recovery. |
| `dashboard/frontend/src/pages/Updates.tsx` | Owner controls, changelogs, progress and recovery UI. |
| `local/config/updates.json` | Private permanent Dev identity and API loopback port. |
| `local/state/updates/` | Verified packages, command history, worker heartbeat and release journal. |
| `local/state/dsp-releases/` | Each DSP's selected release receipt. |
| `local/backups/updates/` | Private Core and per-DSP rollback snapshots. |
| `local/tools/update-worker/` | Retained bootstrap code that survives a Core directory swap. |
| `dsps/<id>/runtime/releases/` | DSP-owned runtime and catalog metadata; newly prepared copies omit optional plugin payloads. |
| `local/packages/plugins/` | Shared verified plugin package cache, used for installation and release approval. |
| `dsps/<id>/plugins/<plugin>/versions/` | That DSP's installed plugin code and retained rollback versions. |

The worker checks both feeds when idle, about every five minutes. **Check for
updates** refreshes the selected product. Every install/start-rollout command
refreshes its product again; a stale button cannot install an superseded release.
An active rollout continues using its pinned digest when a newer release appears.
Release downloads only stage verified files. They do not select code or start
services. Shared dependencies remain versioned copies inside each DSP release.

DSP code and optional plugin packages continue to ship in one DSP release. The
host keeps that full release, but each DSP receives only the runtime and catalog
metadata. The original release manifest/digest authenticates the exact copied
subset. Install copies a sealed plugin into only the requesting DSP. Rollout
updates enabled and disabled installed plugins to the selected release versions;
uninstalled plugins are not copied. New DSPs have only the built-in Cortex
connection until plugins are installed, and use the last completed fleet release.
New plugins are visible only to DSPs on a release that approves them. Update Dev
exposes them to Dev first; rollout exposes them to each DSP as it updates. Both
session bootstrap and the Plugins endpoint apply this same catalog filter, so
signing in or opening a platform-owner DSP view cannot reveal a Dev-only plugin.

Existing full runtime copies remain readable for rollback. Installing Core does
not rewrite those copies. New DSP creation and preparation of a new DSP release
use the smaller layout. Previously installed or historical release code remains
retained for recovery; this change does not delete credentials, settings, business
data or rollback packages. Runtime-only copies are verified by the host's
`verifyRuntime`; `verifyRelease` still requires the complete publication archive.

## Initial deployment and configuration

These steps belong to a separately reviewed installation procedure. They are not
performed by publication or by opening the Updates page.

1. Publish a reviewed Core release containing these controls. Identify the exact
   Core and DSP manifests/digests for the initial split deployment. Make private
   offline backups and rehearse the cutover and rollback in an isolated platform.
2. Provision or select the permanent testing DSP. It must be an existing, ready
   directory installation. Validate Core with synthetic data and a separate API,
   dashboard, state, ports and service names before the production cutover.
3. During the installation maintenance window, install the verified Core code at
   `live/`. Install and pin a verified DSP runtime for **every** retained DSP;
   each must have its own `runtime/releases/<digest>` and selected receipt.
   Migrate existing plugin receipts/approvals as needed without replacing DSP
   credentials, settings or databases. All initial DSPs must share one approved
   release. No retained DSP may depend on the old `live/runtime` fallback.
4. Using the installed code and private `DISPATCH_PLATFORM_CONFIG`, run
   `bin/dispatch-updates configure DSP_ID API_PORT`. It validates Dev and writes
   the private configuration. The Dev identity cannot subsequently be replaced.
   Normal decommission and deletion paths protect that DSP.
5. Stage the published baselines through `GitHubReleases.refresh('core')` and
   `.refresh('dsp')`, using `LocalReleases` rooted at `local/state/updates` with
   the configured Dev identity. Staging has no activation hooks. The host needs
   GitHub CLI with `gh attestation verify`, Python 3 and outbound access to GitHub
   and its release asset hosts. CLI authentication stays private; no GitHub write
   permission is needed for discovery or verification.
6. With Core services stopped, run `bin/dispatch-updates adopt CORE_DIGEST`.
   This only records an **already installed** baseline. It verifies live files,
   each DSP receipt, protocol compatibility and permanent Dev. It does not perform
   the monolithic-to-split migration and will reject a mismatched live tree.
7. Prepare service units with the existing startup tooling. When configured,
   `prepareStartup` also renders `dispatch-updates.service`. Review and install
   the generated unit alongside the API/dashboard units, then enable the worker.
   Its API port must match `updates.json`. Confirm installed versions, worker
   health and owner access before leaving maintenance.

A missing configuration leaves the page disabled. No guessed Dev identity,
version, baseline or production service activation is supplied automatically.
Core `0.0.1` predates the worker, so the initial installation cannot be bootstrapped
by clicking Update Core on that release. The source implementation and its
adoption command are not a completed production migration.

## Activation and recovery

Core and DSP updates require matching protocol versions; incompatible updates are
rejected before activation. Releases retain their own SDK/package versions.
Core changes can temporarily interrupt the shared dashboard/API even though DSP
code does not change. The browser reconnects and reloads after the Core digest
changes. A retained bootstrap worker runs outside the replaceable live tree and
hands off to the active Core release's verified worker after a successful update.

Core snapshots include configuration, secrets and private Core state, excluding
the updater's own journal. A failed health check restores the previous Core code
and compatible state, including database schema. Bootstrap configuration remains
readable during recovery. DSP snapshots include that DSP's credentials, settings,
databases, sessions and plugin installation state. DSP rollback restores only
that DSP's files and associated plugin authority; it does not replace the entire
Core database or another DSP's data.

Idle DSPs with a recorded scheduler sleep request can wake for installation and
live health verification. Their normal idle policy resumes afterward. A failed
update returns an originally sleeping DSP to sleep. An owner stop, suspension,
uncompleted setup or newer lifecycle request is never silently overridden; the
rollout pauses until the owner resolves it. DSPs already asleep before the sleep
receipt support was installed require one normal wake/sleep cycle before the
updater can distinguish them from deliberate stops.

**Pause rollout** takes effect between DSPs. **Resume rollout** retries the same
pinned version. Worker restarts mark in-flight commands interrupted and pause
rollouts; an interrupted activation must recover before new installs. Use
**Recover update** when the API is available. If Core is offline, the platform
operator can queue recovery with the retained worker code:

```sh
DISPATCH_PLATFORM_CONFIG=/absolute/private/config/platform.json \
  /absolute/retained/bin/dispatch-updates recover OWNER_USER_ID
```

The user ID must still identify an active platform owner. The external worker
executes recovery. Do not clear the operation journal, swap code manually or
replace a database to bypass an interrupted update. Existing release packages,
command records and snapshots are retained; automatic retention/pruning is not
implemented. Monitor private disk usage and archive only after reviewing which
receipts and rollback operations still reference those files.

## Verification

`npm test` covers command authorization/idempotency, release verification, latest
release ordering, lifecycle rollback, interruption recovery, scheduler sleep and
per-DSP isolation. `npm run test:integration` exercises the wider API/dashboard.
After building the dashboard, run these browser checks:

```sh
cd dashboard
npx playwright test --config playwright.updates.config.cjs
```

The explicit `dashboard/examples/independent-updates-preview.js` fixture uses
synthetic owners/DSPs and simulated host actions. It is not a production updater.
The browser checks cover independent controls, newer-release reset, paused
rollout, sequential resume and mobile layout. CI runs the same browser checks.

`tests/architecture/release-update.acceptance.js` additionally installs a real
Paycom package in a private Linux/systemd namespace lab. It verifies Cortex-only
startup without optional plugin payloads, installs Paycom, switches DSP and
Paycom versions, wakes a sleeping DSP and checks rollback of its private state. Provide sealed
Node/tini and browser tool roots plus explicit Core/DSP release directories via
`DISPATCH_WORKER_TEST_TOOLS`, `DISPATCH_WORKER_TEST_BROWSER`,
`DISPATCH_UPDATE_TEST_CORE` and `DISPATCH_UPDATE_TEST_DSP`. It uses synthetic data
and no provider credentials. Native Core service swapping still requires a
separate deployment rehearsal with isolated service names before live cutover;
unit lifecycle tests inject service control while exercising real files/SQLite.
