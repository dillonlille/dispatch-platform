# Dispatch plugins

Dispatch distributes reviewed, versioned packages. The platform catalog describes
available plugins; clicking Install copies the selected package and its bundled
SDK into that DSP's `plugins/<id>/versions/<version>/` directory. DSPs keep separate
files and version receipts. Updating a distribution package does not update
already installed DSPs. Owners explicitly choose Update when a newer version is
available. The current build target is Paycom.

Source belongs in `plugins/<id>/`: `frontend/` contains React pages, `backend/`
contains provider code and login adapters, and `dispatch-plugin.json` declares
permissions, pages, actions, jobs, collectors and schedules. Paycom's
`backend/installed.js` exposes the standalone worker entrypoints. Its
`dashboard/published.js` supplies the package's bounded published-data reader;
legacy HTTP handlers remain for compatibility. Installed entrypoints execute in
DSP-scoped workers, never through a require of DSP code in the Core process.

`tooling/build-installed-plugin.mjs` builds backend and auth bundles, a separate
frontend bundle, declarative collection definitions, a private SDK copy and a
SHA-256 package inventory. `tooling/distribute-plugin-package.js` verifies a
reviewed digest and adds an immutable version to the private platform catalog.
DSP HTTP requests cannot supply executable paths, archives or arbitrary digests.

Installation fences the DSP, drains work, copies and verifies code, snapshots
plugin state, initializes/migrates the package in an isolated worker, writes its
receipt and connection grants, applies collection definitions, and then records
Core acknowledgement. Failed initialization restores the snapshot while fenced.
Interrupted acknowledgement retries the same revision. An always-on DSP resumes
after acknowledgement; an on-demand DSP returns to its existing execution queue.

The owner page supports Install, Update, Disable, Enable and Uninstall. Signed
platform-owner DSP views have the same owner authority and retain actor audit
attribution. Disable and Uninstall immediately close the Core access gate,
revoke sessions and stop schedules. Re-enable preserves the selected version and
prior schedule state. All these actions retain credentials and business data.

The independently loaded dashboard bundle is selected by acknowledged version
and revision. Its authenticated asset endpoint verifies the installed inventory
and current DSP authority, including after reads. The shell supplies the UI SDK,
React and authenticated HTTP transport. Reviewed frontend JavaScript shares the
shell origin; it is not a sandbox for arbitrary third-party UI code.

Backend plugins use `dispatch-sdk` for connections, jobs, schedules, storage,
publication, actions and structured progress. The SDK transport is bound to one
DSP/plugin/revision/job; caller-supplied identity cannot widen its authority.
Provider passwords remain in a DSP's encrypted auth vault and are exposed only
to its separately isolated login worker. Plugin executables and private state
are separate. See [the SDK](../sdk/README.md) and the
[storage, operations and migration guide](../docs/plugin-runtime.md).

Cortex remains automatic sign-in and owner-entered email verification. This
plugin system adds no Cortex collection or synchronization.
