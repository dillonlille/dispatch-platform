# Releases and operation

## Dev updates

Feature PRs target `dev`. The owner gives standing approval to merge completed,
reviewed feature PRs with passing checks unless they ask to hold a PR.
Successful merged-dev checks upload a compiled GitHub Actions artifact. Because
the repository is public, artifacts contain **code only**, never state or
credentials. The configured Dev updater downloads and verifies that artifact and
updates the full test platform automatically, checking every 10 seconds. Exact
merge-tree validation can be reused from a successful PR; a new build and smoke
check still run against the merged commit. Release/manual checks always run the
full suite. See [DEVELOPMENT.md](DEVELOPMENT.md).

## Prepare a release

When the owner says **Prepare a release**:

1. Summarize changes since the last published release and show known running versions.
2. Ask for the version if it was not already supplied.
3. Pin the accepted `dev` revision, apply versioning, and verify the final compiled
   candidate in Dev. Unmerged PRs and unfinished edits stay out. Application changes
   require revalidation.
4. Merge the tested source into `main` through a release PR.
5. Publish one immutable `vX.Y.Z` release containing the verified runtime artifact
   and its `release.json` inventory/digest. Verify assets and source provenance.

The agreed future Production workflow automatically installs a published stable
release into `public/live/`, preserving sibling `config/`, `data/` and `dsps/`.
Drafts, prereleases and main merges do not trigger Production activation. The
release request includes the resulting automatic update, without a separate
Promote action.

**Production provisioning, release publishing automation and Production deployment
are not installed by this Dev setup.** Implement and verify them when requested.
The retired Node gateway and in-dashboard activation commands are removed.
GitHub and the external updater own deployments.

## Build integrity and rollback

`.build/release.json` uses format 2 and records the version, Rust runtime, browser-worker Node major,
compatibility schema 3, every
runtime file hash/size and aggregate digest. `tooling/build-info.json` records the
source commit. Symlinks, hardlinks, unexpected files and unsafe paths are rejected.
The Dev updater additionally verifies the GitHub artifact archive digest and that
its workflow succeeded for a push to the current `dev` head.

Updates serialize through a lock and write an activation receipt before replacing
code. Failed health checks restore the prior artifact and source revision. Keep
schema changes compatible with that artifact; code rollback does not undo data
migrations. Recovery refuses to overwrite unrelated edits to the checkout.

## Backup and restore

With the Dev service and updater timer stopped, load `config/platform.env` into the
operator process environment and use the built CLI:

```text
live/.build/services/rust/dispatch-backend backup /absolute/private/backup-destination
live/.build/services/rust/dispatch-backend restore /absolute/private/backup /absolute/empty/restore-target
```

Standalone backups include `data/` and `dsps/`. Keep a separate private backup of
`config/`; environment configuration is not included in the state archive. Restore
validates checksums, revokes old sessions/invitations/reset links and cancels
pending jobs. Configure and verify a compatible artifact
before restarting a restored platform.

## Fresh Rust cutover

The initial Rust core changes password and credential formats. Existing Node data
is deliberately discarded only by the explicit Dev reset described in
[Dev setup](docs/DEV-SETUP.md#fresh-state-cutover-from-the-node-core). The normal updater
refuses this schema transition. Future Rust updates preserve data and retain the
previous compatible Rust artifact for rollback.
