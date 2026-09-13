# Architecture and storage

## Source map

```text
dispatch-core/                     future Core repository
  core/api/                        authenticated HTTP API
  core/accounts/                   identities, DSPs, roles and owner authority
  core/browser-manager/            browser admission, leases and recovery
  core/auth-broker/                 coordination of DSP login workers
  core/plugins/                    installed package authority and SDK services
  core/updates/                    independent release and rollout state
  core/agents/                     agent hub and collector capacity
  core/installations/              lifecycle, backups and recovery compatibility
  dashboard/                       complete shared UI, including platform owner
  sdk/                             separately packaged SDK and authoring tools
  shared/                          dispatch-protocol contracts and helpers
  packages/runtime-kit/            shared queue/storage adapters
  host/                            DSP processes, storage, network and recovery
  tooling/                         builds, exports and checks
  tests/                           synthetic integration and native acceptance

dispatch-dsp/                      future DSP repository
  runtime/                         DSP execution, supervisor and local vault
  plugins/paycom/                   Paycom code, declarations and frontend
  tooling/frontend/                independent compiler dependencies
  bin/                             runtime and developer commands
  compatibility/                   retained legacy adapters
```

Core authorization and the host controller compose the dashboard service. A
separately supervised Core backend coordinates installed plugin workers and
browser/authentication workers. Each active DSP has its own isolated supervisor
using the shared framework, plus actual DSP-local copies of its installed plugin
versions. Plugin code executes in disposable namespaces with scoped SDK sockets
and storage. No per-DSP Linux accounts are created. See the
[installed runtime and migration guide](plugin-runtime.md).

## Private DSP storage

```text
dsps/<dsp-id>/
  plugins/<plugin>/versions/<version>/   installed executable package and SDK
  config/
    dsp.json
    installation.json       when provisioned by Core
    storage-layout.json     version 2
  data/
    db/
      paycom/paycom.sqlite3
      <feature>/<database>  a feature can own multiple databases
    files/<feature>/        retained downloads, exports and original files
    auth-broker/credentials.sqlite3
    collection-manager/collection-manager.sqlite3
    published/plugins/<plugin>/         read-only query projections
  secrets/
    auth-broker/master.key
    runtime-agent/registration-token
  state/
    auth-broker/browser-sessions/
    collection-manager/
    plugins/paycom/
  staging/plugins/<feature>/
  run/ logs/ backups/ browser/
```

Only features that use storage need their own data directories. Meal-break
collection can use `data/db/meal-breaks/meal-breaks.sqlite3` and
`data/files/meal-breaks/` without sharing Paycom's database. `featurePaths` in
`shared/paths/feature-paths.js` calculates database, files, state and staging roots.
It accepts the runtime's trusted roots and validates the feature identifier.

The auth broker and collection manager keep their service databases separate
from collected business data. Keys and browser sessions never belong in a plugin
source directory. Disabling/uninstalling a plugin gates access and scheduled work;
it does not delete retained data or replace credential verification guards.

Hidden `.control`, `.service-root`, `.code-view`, `.storage-view`, and volume files
are host-managed infrastructure. Some visible directories are mounted views into
a bounded volume. Move feature subdirectories offline; do not move mounted DSP
roots or volume files as a cosmetic cleanup.

## Platform and development storage

`local/config` holds private platform configuration, `local/secrets` holds
operator verification credentials, `local/state` holds durable platform state,
and `local/tools` holds managed binaries. Operational helpers/receipts go in
`local/operations`; retained history goes in `local/archive`. Logs, browser
profiles, cache, temporary files, run sockets and manual backups remain private.

`dev/source/dispatch-core` and `dev/source/dispatch-dsp` are the editable trees. `dev/build` contains build output and receipts;
`dev/work` contains current task notes. Historical development material is archived
separately. `worktrees` is reserved for a future Git workflow.

## Expansion and capacity

New plugins live under `dispatch-dsp/plugins/<id>`. The platform discovers trusted manifests,
checks contribution collisions, stores per-DSP desired installation revisions,
and reconciles them with the runtime. HTTP actions retain DSP authorization,
signed support-view scope, CSRF protection and audit attribution. See
the plugin documentation in the DSP project.

Directory runtimes use shared collector capacity leases for every managed
collector. Worker requests default to one and can request up to six through source
configuration; the host grants only available capacity. Per-DSP FIFO queue
positions prevent one DSP filling the queue. Leases expire after disconnects and
startup recovery reserves a cooldown for old work to terminate. The default
worker budget is conservative and derived from CPU/RAM. Agent connection limits
default to 256 and are constructor-configurable. These limits are resource
controls, not throughput measurements.

Runtime recovery uses two concurrent operations and records individual failures.
The dashboard can listen while recovery proceeds; its provisioning worker starts
after that recovery pass. Lifecycle, plugin, diagnostics and onboarding
reconciliation settle independently. Host mutations still use the durable journal
and operation lock; conflicting host changes remain serialized.

The current directory backend is **single-host** and uses Unix sockets and local
volumes. Separate host/controller and transport boundaries make a future host
placement service possible, but remote hosts, distributed storage and an actual
100-DSP capacity result are not implemented claims. Expansion still requires
sufficient CPU, RAM, disk and provider capacity. Framework checks create no DSPs.

## Independent activation

Core and DSP development artifacts contain separate code trees, dependency copies,
content hashes and protocol compatibility declarations. DSP plugin packages are
sealed separately. The runtime selector reads a private receipt for each DSP and
mounts that DSP's installed runtime. The SDK copy belongs to the selected artifact.

Staging a release or plugin package does not select it for any DSP. Per-DSP package
approval is explicit. The local coordinator persists Dev verification, resets it
when a new candidate arrives, pins an active rollout and advances one DSP at a time.
A failed activation restores through the supplied lifecycle hook and pauses the
rollout. Publishing and host activation remain separate owner-controlled operations.
See the repository RELEASES.md for the workflow and remaining deployment work.
