# Native DSP services

Dispatch uses one shared release of built-in DSP code. Each DSP has a separate Linux account, private data and secrets, and a systemd service. No container image, container engine, per-DSP application checkout or per-DSP dependency install is created. DSPs cannot install plugins or run custom code.

## Creating and operating a DSP

The dashboard invitation flow creates the DSP and owner invitation, provisions infrastructure, accepts the invitation, and collects DSP details. Those steps complete DSP onboarding. The owner can optionally connect Paycom later from the Paycom page; authentication or import failures do not disable the workspace. Core owns shared login, users, memberships, invitations, administration and the dashboard.

Creating infrastructure allocates a `dsp-<opaque suffix>` account, private directories under `/var/lib/dispatch/tenants/<suffix>`, a registration credential, one DSP service and its authenticated Runtime Agent relay. The service mounts the shared immutable package at `/opt/dispatch` and only that DSP's private files at `/var/lib/dispatch/<runtime key>`. CPU, memory, tasks and temporary storage are bounded. Browsers use private Unix sockets and Chrome's debugging pipe, with no tenant debugging TCP port.

The shared Core/dashboard package lives at `/opt/dispatch-platform/releases/<release>/core-artifact/code`. DSP code, Node and Chrome live at `/opt/dispatch-runtime/releases/<release>/runtime-artifact`. The separately supervised updater continues working when Core restarts. The existing `runtime/` source directory name remains for compatibility; it does not select the deployment backend.

Remove DSP revokes tenant sessions and access immediately, pauses queued work and backup scheduling, and stops and disables its services. The retained DSP stays in Removed with its data, completed backups, registration credentials, service definitions, and required release artifacts preserved. Backups are protected from expiration while removed. Restore DSP verifies the runtime and publication before reopening access and restoring its previous collection schedule; ordinary backup scheduling and retention resume afterward. Missed scheduled runs are not replayed. Users belong to one DSP, and platform support uses the separate viewing context.

Permanently delete DSP is available only after removal and requires the acting Platform Owner's password. It erases local files and remote backups, removes the account and services, revokes registration credentials, and erases DSP metadata and user accounts. Platform owner accounts are preserved. Final root coordination metadata is swept only after account, files and Core identity are gone. Failures remain retryable and visible.

Historical full-platform backups contain shared identity records and can contain the deleted DSP's data. Explicit DSP deletion erases Core/full-platform backups containing that DSP as well as its individual backups. Complete root-verified organization inventories preserve Core backups that do not contain it; older incomplete inventories remain conservative. Other DSPs' individual archives remain. See [recovery](RECOVERY.md).

See [collection capacity and staged verification](COLLECTION-CAPACITY.md) for shared collection limits, the browser sizing probe, and optional test-DSP rollout verification.

## One platform version

A rollout backs up and verifies Core first, updates Core, then updates every DSP sequentially. Native DSPs still waiting for their owner or DSP details retain their setup state. DSPs without Paycom can be ready and receive updates without publication checks; connected DSPs continue to verify publication continuity. Suspended DSPs receive new code and remain stopped. A pending DSP without infrastructure receives the target release assignment. Newly created DSPs join the rollout; active provisioning/onboarding is allowed to settle before its update.

A failed update pauses progress and uses the in-flight safety snapshot and old code for compensation. These temporary copies exist only while needed to complete or recover the rollout. The rollout is not marked complete until the root cleanup worker attests current service definitions, confirms recovery proofs, checks that no process still uses old releases, and removes obsolete Core/runtime/helper/updater/watcher releases and local recovery copies. Current code and a newer already-prepared candidate can remain. Historical rollback uses Cloudflare backups.

## Transition from the container deployment

Native releases require the updated release watcher. Once this branch is merged and a user-requested release is being prepared, run the [release-delivery bootstrap](RELEASES.md) from that clean merged checkout using the existing private host configuration and GitHub token. This updates discovery only; it does not select or start a rollout. The next normal rollout installs the native Core and host helpers. Existing OCI DSPs must be explicitly migrated or removed before the native fleet can complete; the current test DSP was authorized for removal rather than migration.

The root backup configuration and decryption key must be present before rollout. The candidate's fixed `prepare-backup` entrypoint starts verified backup service setup before Core replacement. It can initialize an empty repository following the requested backup wipe. Export a private recovery kit and keep it off the VPS before relying on disaster recovery.

Starting a native rollout rejects non-native DSPs that have not finished decommissioning before it queues the Core update. Decommissioned history does not block the transition.

## Verification and local builds

Use clearly named disposable test DSPs in the existing live setup for operational checks. Verify the installed release and backend first: a live host still running the container backend cannot validate native provisioning. Keep checks scoped to the test DSPs and protect existing DSPs and shared services. Do not run full-host loss, reboot or destructive recovery drills on the live host.

CI runs repository, frontend browser and native service/package verification. It does not create a testing VM. The old [VM lab](tests/native-lab/README.md) is retained only as historical recovery-test source and is not part of the current verification workflow.

Run `./tooling/verify` for repository tests. A native package build requires a clean checkout, Node, Python, `patchelf` and Chrome at `/opt/google/chrome`:

```sh
./runtime/tooling/build /absolute/new-output-directory
./runtime/tooling/verify
```

The second command creates a temporary package and exercises two disposable service accounts, private Chrome, independent stopping and restoration of code/data/accounts/services. It requires passwordless sudo and cleans its fixtures. Legacy OCI examples are retained for compatibility investigation and are not invoked by normal build, verification or release publication.

Native services retry startup at a fixed interval without a permanent systemd start-limit latch, so delayed Core availability is recoverable.
