# Installed plugin packages

DSP releases contain the runtime, catalog metadata and separate sealed plugin
packages. Core retains the complete verified release and plugin cache. Preparing
a DSP copies only the runtime and metadata into its runtime release directory;
optional plugin backends, frontends and dependencies are not copied there.
New DSPs expose the built-in Cortex connection and start with no optional plugins
installed. Catalog metadata does not enable a plugin or create its credentials.

`install.js` verifies approved package digests and copies actual files into each
DSP's `plugins/<id>/versions/<version>/` directory. It rejects links, unexpected
files, path traversal, incompatible SDK versions and mutated version contents.
Activation writes an atomic host receipt under `config/plugins/<id>.json`.

`lifecycle.js` persists staged, initialized, activated and applied phases under
`config/plugins/operations/<id>/<revision>.json`. It runs through an injected DSP
lifecycle lock, drain hook and idempotent scoped initialization/migration worker.
Only readiness permits activation, and only matching runtime acknowledgement
permits Core acknowledgement. Interrupted acknowledgement resumes without
repeating completed initialization. Initialization must itself use the supplied
operation id to recover a crash before its completion receipt is written.

The DSP's selected release approves the exact plugin versions available to it.
Update Dev and sequential rollout update only that DSP's installed plugins,
including disabled installations, while preserving their enabled/disabled state.
Plugins not installed remain absent; a later Install uses that DSP release's
approved version. An explicit per-DSP catalog never inherits additional plugins
from the legacy global catalog, even when the per-DSP catalog is empty.

Disable and uninstall drain work and change activation state. They retain
credentials, data, profiles and package bytes needed for recovery. Reclaiming old
versions and code/state rollback remain separate migration tasks.

`sdk-socket.js` serves a bounded private Unix socket with an immutable host-bound
SDK context and cancellation on disconnect. The worker mount plan is in
`host/services/plugin-worker-layout.js`. The directory lifecycle integrates scoped worker launch, provisioning and
backup snapshots. The directory API owns reconciliation; the split dashboard
process owns only static delivery and HTTP forwarding.

The package sealer is `tooling/build-plugin-package.js`. Its input must already
contain compiled, self-contained entrypoints and dependency files. It does not
compile a source plugin or run package scripts.
