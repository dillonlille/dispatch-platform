# Release commands

`release.py` is a compatibility launcher for `dispatch-host release`. It builds the
host tool from the current checkout and replaces itself with that process, keeping
progress output and signals attached. Rust owns release policy; the existing Node
smoke check still exercises the exact compiled application with disposable data.

Run from a checkout with its Node dependencies installed and authenticated `gh`:

```bash
python3 tooling/release.py status
python3 tooling/release.py prepare
python3 tooling/release.py publish 0.0.14
```

The version above is an example. Preparation defaults to the next patch, or resumes
the single unfinished release. `--bump minor|major`, `--dev-commit REV`, `--notes PATH`
and `--releases PATH` retain their existing meanings. Explicit versions must be
stable `X.Y.Z` versions. Multiple unfinished releases require an explicit version.

| Command                     | Effects and stopping point                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status [X.Y.Z]`            | Reads GitHub, verifies saved preparation and reports public health as JSON. Does not fetch Git refs, create release directories or write receipts. Defaults to the unfinished release, otherwise the latest published stable version.                      |
| `prepare [X.Y.Z]`           | Pins the accepted Dev commit, opens and merges the release PR after checks, downloads the checked main artifact, opens the Dev sync PR, smoke tests it, uploads and verifies a draft. Stops before publication.                                            |
| `publish [X.Y.Z]`           | Requires existing preparation and a draft or published release. Rechecks local bytes, tag identity and draft checks, completes missing uploads, publishes, verifies Production health and dashboard assets, finishes Dev sync and cleans merged worktrees. |
| `run [X.Y.Z]` or no command | Performs preparation and publication together, preserving the legacy invocation.                                                                                                                                                                           |

`prepare` includes the release merge into main; use it only when that release work
is authorized. A branch with a merge queue holds a merged PR open until the queue's own
run passes; the command waits up to thirty minutes for that and resumes if it stops. `publish` includes publication and the release's Dev sync merge.
Neither command changes Production host configuration or installs its manager.
The installed updater activates the published release using its existing policy.

# Recovery and stored state

Rerun the same command after fixing the reported problem. The command takes an
exclusive lock in the releases directory, and `.vX.Y.Z-state.json` pins the accepted
Dev revision and merged release commit. GitHub remains authoritative for PR and
publication state. A published release resumes Production verification and Dev sync
without repeating the smoke test or sending another publication request.

Preparation downloads into a private sibling staging directory. Only a completely
verified and flushed preparation becomes `vX.Y.Z/`, through an atomic rename that
cannot replace existing output. A killed process may leave a `.prepare-vX.Y.Z-*`
directory for inspection; retries do not reuse or remove it. Existing complete
preparations are checked against their provenance, manifest and every checksum
before reuse. Legacy incomplete or altered final directories stop with an error;
preserve them for inspection rather than overwriting them.

Draft creation and each asset upload are separate operations. If a connection drops
after GitHub accepts an upload, a retry verifies that asset and uploads only missing
names. Unexpected, duplicate, incomplete or mismatching existing assets stop the
command. It never uses `--clobber`, deletes an asset or overwrites a tag.

The existing archive, `release.json`, `provenance.json`, `SHA256SUMS`,
`draft-verification.json` and `deployment-verification.json` formats are retained.
`smoke-verification.json` binds a successful smoke check to the archive hash, commit
and runtime digest. Failed checks, a pending newer run, smoke failures, incorrect
tag targets or incomplete asset verification prevent publication. Failed Production
verification or Dev sync leaves the journal unfinished so a bare rerun finds it.

Release and sync worktrees stay under the platform's `worktrees/` directory, including
when the launcher is invoked from a feature worktree. Cleanup removes only clean
worktrees and local branches still at their merged PR heads. Custom notes, changed
notes, uncommitted work and recovery state are preserved.

Legacy directories older than the latest published version may predate deployment
receipts; they are retained as history and do not trigger automatic resumption.
Explicit unfinished journals remain discoverable even for an older version.
