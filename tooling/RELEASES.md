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
the single unfinished release. `--bump minor|major`, `--notes PATH` and `--releases PATH`
retain their existing meanings. `--commit REV` releases another commit on `main` instead
of its head. Explicit versions must be stable `X.Y.Z` versions. Multiple unfinished
releases require an explicit version.

A release publishes a commit already on `main`; there is no release branch or PR. The
build `main`'s push run published for that commit is released under the release's
version: only `release.json` changes, stamped with the version and sealed again, so every
file is the exact bytes CI built and tested. `package.json` keeps the version the source
names, which is what Dev reports.

The release commit needs the full suite. A merge queue group, `main`'s push or a manually
dispatched run of that exact commit counts when its `core` job ran, and so does a queue
group that reused its PR run when that run's receipt records full validation of the same
merge. Otherwise the command pushes a temporary `release-checks/vX.Y.Z` branch at the
commit, dispatches one full run there and waits for it, then deletes the branch. A failed
run stops the release and stays for inspection: rerun its failed jobs and then this
command, or merge a fix and start again with `--commit origin/main`, which replaces an
unprepared pin.

| Command                     | Effects and stopping point                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status [X.Y.Z]`            | Reads GitHub, verifies saved preparation and reports public health as JSON. Does not fetch Git refs, create release directories or write receipts. Defaults to the unfinished release, otherwise the latest published stable version. |
| `prepare [X.Y.Z]`           | Pins `main`'s head, requires the full suite on it, downloads `main`'s checked build, stamps the version, smoke tests it, uploads and verifies a draft. Stops before publication.                                                      |
| `publish [X.Y.Z]`           | Requires existing preparation and a draft or published release. Rechecks local bytes, tag identity and draft checks, completes missing uploads, publishes and verifies Production health and dashboard assets.                        |
| `run [X.Y.Z]` or no command | Performs preparation and publication together, preserving the legacy invocation.                                                                                                                                                      |

`prepare` may dispatch a full run; it waits up to thirty minutes for it and resumes if
it stops. `publish` includes publication. Neither command changes Production host
configuration. The installed updater activates the published release using its existing
policy, then replaces itself with that release's own copy once it passes a self-check.

# Recovery and stored state

Rerun the same command after fixing the reported problem. The command takes an
exclusive lock in the releases directory, and `.vX.Y.Z-state.json` pins the release
commit. Journals from releases made through a release PR keep their Dev revision. GitHub
remains authoritative for check and publication state. A published release resumes
Production verification without repeating the smoke test or sending another
publication request.

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
verification leaves the journal unfinished so a bare rerun finds it.

Cleanup deletes the temporary checks branch if one is left. Custom notes, changed notes
and recovery state are preserved.

Legacy directories older than the latest published version may predate deployment
receipts; they are retained as history and do not trigger automatic resumption.
Explicit unfinished journals remain discoverable even for an older version.
