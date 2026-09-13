# Runtime plugin host

`installed.js` verifies a DSP-installed package, creates its scoped SDK client
and loads its declared runtime entrypoint lazily. Actions require a manifest
declaration and current authorization both before and after execution.

`storage.js` supplies plugin-scoped database and file handles with private paths,
bounded SQLite caches, at most eight open databases, bounded file reads and
atomic file writes. Filesystem namespaces remain the enforcement boundary for
executable plugin code; SDK path validation alone is not a sandbox.

`index.js` remains the compatibility runtime until package installation and the
scoped worker launcher are connected. It has not silently switched existing DSPs
to installed code. Installed-package tests exercise the new loader independently
with copied packages and injected SDK services.
