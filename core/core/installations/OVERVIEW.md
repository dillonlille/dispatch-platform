---
title: Dispatch Provisioner
status: current
last_verified: 2026-09-03
---

# Dispatch Provisioner

`core/provisioner` owns the internal server-side capabilities that materialize, supervise, configure, activate, back up, restore, upgrade, suspend, and retire one isolated Dispatch runtime per DSP. Version `0.6.0` implements layout version `1`, durable provisioning job schema version `3`, service-plan version `3`, Access Control-authorized live jobs and Runtime Agent credentials, managed Paycom activation, and the Access Control-fenced lifecycle controller. It is not exposed through the public SDK, Runtime Gateway, Runtime Agent protocol, or browser API.

Access Control is the lifecycle and organization/runtime-binding authority. Its durable provisioning request is an outbox record; the Provisioner first creates an idempotent but unrunnable job, Access Control records that exact job as current, and only then may the Provisioner persist a live-job authorization. A crash at any boundary leaves the request replayable and the installation non-ready. A successful live service job reconciles to `waiting_for_owner` or the legacy `waiting_for_provider_auth` state. For isolated DSPs, workspace reconciliation promotes the installation to `ready` and the organization to `active` once the owner is active and DSP details have been applied. Paycom authentication and first publication are optional integration work, performed later without changing workspace readiness.

## Runtime layout

`src/layout.js` consumes a manifest already bound to separately loaded server authority. It supports only reviewed template `isolated_dsp_v1` and derives every path beneath one preconfigured owner-private installations root. A caller cannot select a filesystem path.

Each runtime receives distinct private `config`, component data, secrets, state, runtime socket, provider staging, logs, and backup roots. `secrets/runtime-agent` holds only that runtime's exact-mode registration token. Access Control is deliberately absent because human identity and installation routing are control-plane responsibilities. Internal path/environment projection maps the layout into the exact Auth Broker, Collection Manager, Runtime Agent, Paycom, and CDF settings without exporting managed paths through the public SDK or emitting `DISPATCH_LOCAL_ROOT` or an Access Control database root.

The installations root must already exist as a canonical owner-owned exact-mode `0700` directory outside and not above the source checkout. Existing structural directories must also be canonical owner-owned exact-mode `0700` directories on the expected filesystem. Symlinks, mount/device changes, wrong types, special mode bits, unknown structural entries, source overlap, root replacement, authority disagreement, and unsupported templates fail closed before a partial tree is extended.

Creation is idempotent and every mutation is read back. Layout cleanup remains a separate, non-recursive fixture capability that requires trusted failed/no-retention authority and refuses files, unknown entries, or nonempty leaves.

## Durable jobs

`src/job-store.js` owns schema version `3` in fixed file `provisioner.sqlite3` beneath a dedicated pre-created control-state root. The root is canonical, owner-owned, exact mode `0700`, external to the checkout, and separate from installations and service-unit roots. Database files and SQLite sidecars are owner-owned regular single-link files with exact mode `0600`.

Startup uses WAL, full synchronization, foreign keys, bounded storage, integrity checks, complete stored-schema comparison, and root/database identity pinning. An owned exact-mode zero-byte database left before SQLite initialization is recovered transactionally. Schema version `1` is validated and migrated to version `2`; version `2` is then migrated to version `3`, which adds the Access Control acknowledgement authorization table without weakening retained fixture jobs. Unsupported or drifted schemas fail closed.

Two immutable pipelines are readable:

```text
installation_layout_v1
  runtime_layout_materialize
  runtime_layout_verify

installation_services_v1
  runtime_layout_materialize
  runtime_layout_verify
  runtime_service_render
  runtime_service_validate
  runtime_service_install
  runtime_service_start
  runtime_service_verify
```

New jobs use the pipeline selected by trusted server composition. Persisted jobs retain their exact pipeline ID, version, and stage snapshot. Progress derives its total from that persisted snapshot rather than the current default.

Request creation transactionally enforces the authority-bound installation, `platform.installations.manage`, explicit operator enablement, lifecycle and revision rules, authority-scoped idempotency, and one active job per installation. A same-key/same-payload request returns the original sanitized job; a changed payload returns `idempotency_conflict`.

Workers claim with bounded leases, a fixed forward-attempt limit, and increasing fences. Every filesystem or supervisor mutation is guarded by the current installation generation, worker, fence, status, and unexpired lease. Short unit-file operations and nonblocking systemd requests run while the claim transaction prevents a replacement fence. Blocking readiness waits happen outside that transaction; the next mutation or checkpoint revalidates authority. Checkpoint and terminal SQL repeat the claim predicates.

Completed layout and service checkpoints are revalidated by later stages, and complete layout plus service health is read again immediately before success. A stale worker cannot render, install, reload, enable, start, stop, restore, checkpoint, cancel, fail, or succeed after reclaim.

## Managed service plan

`src/services.js` derives three base units and, when central Agent transport is configured, one fourth unit from the authority-bound runtime key:

- one isolated Auth Broker;
- one isolated Collection Manager, ordered after its matching broker;
- one isolated Runtime Gateway, ordered after both matching infrastructure services.
- one outbound Runtime Agent, ordered after the matching Runtime Gateway and connected only to the server-configured central hub.

Paycom and CDF remain Collection Manager child processes. The central dashboard and Access Control are never rendered per DSP.

The service-unit root is trusted server configuration, not a manifest or request field. It must be a pre-created canonical owner-owned exact-mode `0700` directory, external to the checkout and the installation/control roots, and its device/inode identity is pinned. Runtime keys, unit names, executable paths, working directories, health commands, environment keys, arguments, and systemd operations are all code-owned. Issued plans are internally branded so the supervisor adapter rejects caller-fabricated plan objects.

The renderer:

- writes a complete candidate bundle under the runtime's private configuration root;
- permits ordinary path spaces through deterministic systemd escaping;
- rejects reserved characters and an Auth Broker Unix-socket path longer than the Linux pathname limit;
- pins executable and working-directory identity plus executable content digest;
- writes and fsyncs exact-mode `0600` files atomically;
- rejects unknown candidate entries and unsafe destination files;
- runs the fixed root-owned `systemd-analyze verify` command with bounded output and timeout;
- emits only `{servicePlanVersion,status,serviceCount,changed}` receipts.

Units use `Restart=always`, bounded start limits, `KillMode=control-group`, `UMask=0077`, `NoNewPrivileges`, `RestrictSUIDSGID`, `LockPersonality`, native syscall architecture, and the reviewed address-family/namespace settings. A fixed root-owned `env --ignore-environment` launcher discards the user manager's inherited environment before executing the component with only the closed rendered values. The units also unset legacy local-root, Access Control, `NODE_OPTIONS`, and dynamic-loader overrides as defense in depth. No managed unit reads an environment file.

## Installation, health, and rollback

A private exact-mode `0600` transaction journal is written under the trusted unit root before any unit is replaced. Its opaque filename is derived from a digest rather than exposing the runtime key. The journal records the complete prior unit bytes, active state, and persistent-versus-runtime enablement scope. Candidate unit files are promoted atomically one at a time under the durable journal, followed by daemon reload, runtime enablement for the fixture gate, ordered nonblocking starts, and read-back verification.

The user-systemd adapter accepts only a plan issued by `src/services.js` and fixed operations: snapshot, reload, enable/disable, start/stop, failed-state reset, restore, inspect, health, and bounded restart evidence. It validates the installed fragment path, exact process argument, effective UID, cgroup, environment, restart policy, kill mode, umask, enabled/active state, Auth Broker, Runtime Gateway, and Runtime Agent status-socket type/mode/path/owning file descriptor, broker/gateway/Agent health, and Collection Manager lease/status health. After positive read-back, the journal is durably marked `verified` before the job transitions to success, allowing a post-commit cleanup interruption to be distinguished from an unverified installation. A successful `systemctl start` alone is never accepted.

Any service-stage error or cancellation enters durable compensation before rollback begins. Compensation survives worker death, uses a higher fence on reclaim, and has a separate code-owned bound of three attempts. Rollback stops and disables candidate units in reverse dependency order, restores prior unit bytes, reloads systemd, restores prior enabled/active state, and compares the resulting state with the journal. Cancellation additionally removes only the exact candidate files. Rollback never recursively removes runtime data or unknown service-root entries.

Service-plan version `3` adds the optional supervised Runtime Agent to the version-`2` Auth Broker/Collection Manager/Runtime Gateway set. Startup and every fenced mutation validate the complete contiguous persisted checkpoint prefix; service stages also validate the current journal before any supervisor action. Retained earlier-version service job/checkpoint or journal state is rejected before a version-`3` unit mutation rather than being reinterpreted. No live managed earlier-version installation was adopted; old temporary fixtures require the explicit authorized fixture teardown before reuse.

Forward-attempt exhaustion after service work also enters compensation before terminal failure. If rollback itself cannot be completed within its bound, the job fails as `service_installation_failed`; it never becomes ready. Terminal success retains a `verified` journal and successful compensation retains a `restored` journal as private reconciliation evidence outside the DSP layout. The next fenced render finalizes that settled journal before changing any candidate; the controller performs no unfenced post-terminal filesystem mutation. The explicit fixture teardown removes settled journals after proving no competing job exists. No failed candidate replaces prior unit bytes.

## Access Control reconciliation boundary

Fixture registration still requires separate server-loaded pending-fixture/no-retention authority and the `fixture_` runtime-key namespace. Live registration instead requires an Access Control-derived manifest and closed registration authority. A live job is deliberately not claimable when it is first inserted. The implemented durable handshake is:

1. Access Control atomically validates platform authority, idempotency, revision, and lifecycle, moves the installation to `provisioning`, and writes a pending outbox request.
2. The reconciler creates or reuses one private per-runtime Agent token, stores only its digest/generation in Access Control, and never returns the token.
3. The reconciler registers the server-derived live manifest and creates or replays the matching Provisioner job.
4. Access Control atomically records that exact Provisioner job as the installation's current job and marks the outbox request `dispatched`.
5. The Provisioner persists a `live_job_authorizations` acknowledgement bound to the exact job, organization, and runtime; only then may a worker claim it.
6. Before every live host mutation, the worker reopens the Access Control authority transaction, checks the exact manifest revision/current job/runtime/organization status, executes the bounded mutation while that authority transaction is held, and checks the same authority again.
7. A terminal Provisioner job is reconciled back into Access Control. Success becomes ready after the owner and DSP details are complete; otherwise it waits for those steps. Failure remains non-ready with a sanitized code.

`src/installation-provisioning.js` owns the Access Control side of that protocol. Replaying after a crash at any numbered boundary converges on the same request and job. The Provisioner database remains an executor journal rather than a competing installation registry. No browser or public SDK route can call the reconciler or choose its manifest, runtime, roots, units, or worker identity.

## Provider activation

`src/managed-paycom.js` renders the reviewed Paycom Collection Manager definition from the authoritative DSP timezone and fixed project executable. Its profile, source, plans, dependency graph, sync definition, and first request (`paycom-main`, `current`, `full`) are code-owned. The project-root ownership/write chain and code-owned Paycom release-tree, specification, and executable digests bind activation to the reviewed release. The definition contains no credentials, and activation requires exact read-back with no unknown configured collector/source/plan/sync entries.

`src/managed-auth-setup.js` binds the existing Auth Broker setup workflow to one authoritative managed layout and exact configured service plan, including the Runtime Agent when central transport is enabled. It requires literal `create` or `replace` intent and acquires a durable Access Control setup lease before mutation. That lease blocks activation and concurrent setup; every fixed service, vault, and credential-ingress mutation revalidates and renews it, while an expired worker cannot continue. The workflow stops and reads back that runtime's service set, invokes the existing `/dev/tty` credential helper with explicit managed component roots, then restarts and verifies the same service set before releasing the lease. It does not test the provider; `activate` owns the single bounded Auth Broker authentication test. Credentials never enter an argument, environment variable, Access Control, Provisioner state, event, receipt, or routine output. CAPTCHA, MFA, lockout, unknown layouts, ambiguous submissions, and terminal provider states remain human-review stops enforced by the Auth Broker/provider adapter.

`src/activation.js`, `src/managed-activation-runtime.js`, and `src/managed-activation-evidence.js` then perform one idempotent activation. They recheck layout, exact services, Auth Broker, Collection Manager, gateway identity, and provider evidence; apply and attest the fixed definition; run/reuse the job-bound `paycom-periods` baseline; enqueue/reuse the manager-owned current/full five-plan batch; and heartbeat the Access Control fence while polling. A stale worker exits without cancelling shared work. Only the current lease holder cancels/drains exact work at its deadline, leaving activation `verifying` if terminal drain cannot be proven. A fixed catalog-hashed Paycom evidence helper opens the manager and Paycom stores read-only; the Core adapter invokes it through a bounded no-shell stdin/stdout contract. The helper binds the current preparatory run, exact batch verification runs, immutable publication-origin runs, active publication IDs, and content digests while proving the selected target is present in the current pay-period baseline. Access Control persists the closed evidence bundle and its digest atomically with activation-job success, installation `ready`, and organization `active`. A thrown error, failed publication, expired claim, stale worker, or mismatched identity cannot commit readiness.

The server-owner-local entrypoints are `dispatch-managed-activation`, `dispatch-installation-reconcile`, `dispatch-installation-lifecycle`, and `dispatch-runtime-agent-authority`. They require fixed absolute control roots in server/operator configuration and accept no secret, command, endpoint, runtime key, unit name, or provider response from a browser. The private platform console can append fixed provisioning intent and change the organization access overlay; the reconciler derives any resulting fixed suspend/resume work. HTTP never invokes these entrypoints or receives Provisioner identity.

## Managed lifecycle

`src/backups.js` snapshots only the fixed data/state roots while that runtime's services are stopped. It leaves the Auth Broker master key in the separate secrets root, rejects unsafe filesystem entries, writes a private relative-entry/hash manifest, and atomically promotes one server-generated backup directory. Suspended-only restore creates a safety backup and swaps the fixed roots with interruption rollback. `src/lifecycle.js` sequences these adapters through the current Access Control lifecycle lease/fence.

Ready-runtime backup, upgrade, suspension, and decommission first record the managed sync intent, stop it with drain enabled, and prove the manager queue quiescent. Upgrade resolves a different release from an owner-private server catalog, takes a backup, uses the unit transaction journal, verifies target service health and unchanged publication evidence, restores prior sync intent, then advances Access Control's release and manifest revision. Failure restores and verifies prior unit/service/schedule state unless organization suspension now requires the runtime to remain stopped. Resume revalidates infrastructure/publication evidence without authentication, collection, or publication before restoring prior sync intent. Decommission stops and disables units while retaining service definitions, runtime data, and existing backups; it creates no final backup. Removed DSPs can resume their saved configuration and schedules after runtime verification. Permanent destruction requires prior removal and the acting administrator’s password in the platform console, or an approved local command, with failed-attempt retry allowed only through the linked destruction job and strict safe-tree removal.

The entrypoint `dispatch-installation-lifecycle` is server-owner-local. It accepts only closed operation arguments and derives runtime, roots, units, releases, backup binding, and job stages from Access Control/server configuration. `dispatch-installation-reconcile` also resumes queued/expired lifecycle jobs and converges organization suspension/resumption intent.

## Boundary and receipts

Provisioning-request projections contain only request status, job ID, installation/manifest revisions, replay state, and an allowlisted failure. Public-style job and activation projections are likewise closed and aggregate. Manifests, organization/runtime identities, paths, unit names, commands, environments, PIDs, cgroups, sockets, journals, workers, fences, checkpoint bodies, SQLite details, publication IDs/targets, provider responses, stdout/stderr, and exceptions remain internal.

Directory ownership and a user service manager isolate normal operation from other Unix users, not malicious code running as the same account. Stronger per-runtime operating-system isolation remains required before a production second-DSP pilot.

## Verification

Credential-free package verification:

```bash
./core/installations/scripts/verify
```

This builds the package and runs credential-free layout/job/service/activation/lifecycle checks. One compact lifecycle integration covers backup/restore, suspension/resumption evidence, failed-upgrade rollback, successful release advancement, retained decommissioning, and separately approved destruction under temporary roots. Authentication evidence remains synthetic; no credentials or network are used, so this is not live-provider acceptance or a production release-upgrade claim.

The explicit Linux user-systemd fixture gate is:

```bash
./core/installations/scripts/verify-systemd-fixture
```

It drives one fixture through the real seven-stage durable job pipeline and installs a second under a rollback journal, using uniquely named runtime-only units for both. It starts the real Auth Broker, Collection Manager, Runtime Gateway, and outbound Runtime Agent processes, validates health and socket/process/cgroup identity, verifies both Agents through one temporary central hub, rejects crossed runtime targeting, executes gateway-backed status and sync-now calls, completes credential-free collector workers in each isolated manager, proves one healthy automatic restart, forces repeated fixture-manager terminations until the configured start limit suppresses further restart, rolls both fixtures back or removes the committed fixture bundle, verifies failure isolation, removes fixture units/journals, and confirms the existing local reference services were not restarted. It does not use provider credentials, open EXMP state, add public routing, or perform a live-provider `ready` transition.

For isolated DSPs, `src/owner-onboarding.js` executes an optional owner connection request through the fixed private `paycom.setup` protocol. `optional-paycom-activation.js` records and verifies integration publication evidence independently of workspace readiness, then starts and reads back recurrence. Connection failures remain retryable without disabling the DSP. Existing legacy activation requests keep their original recovery path. Backups, upgrades, suspension and restoration of provisioned DSPs that have never completed Paycom activation verify infrastructure without requiring a Paycom schedule or publication. After a connection succeeds, lifecycle publication continuity checks apply as before. The shared runtime-only Paycom definition and activation implementation live under `runtime-container/src`; the legacy provisioner modules preserve their existing exports. The OCI image contains neither Access Control nor host provisioning code. See DSP acceptance.

## Update recovery

[Update recovery and Cloudflare R2 backups](RECOVERY.md) describes Core rollback, recovery after interruption, DSP compensation replay, encrypted off-server restore verification, setup, and recovery limits.
