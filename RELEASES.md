# Dispatch releases

Development lives on `dispatch-dev`. Its `/home/thepickle/dispatch-platform/dev` checkout tracks `dev`; passing
checks for the current merged revision install the verified Dev artifact. Keep
unfinished work in separate worktrees. Production contains an installed runtime,
private state and management scripts; it needs neither a Git checkout nor build tools.

## Prepare a release

Run one command from the live checkout on `dispatch-dev`:

`python3 tooling/release.py [X.Y.Z] [--bump minor|major] [--dev-commit <sha>]`

Without a version it releases the next patch version. Existing tags and release
assets are immutable. Every step first reads what GitHub and the private release
directory already hold, so after a failure fix the cause and run the same command
again; a bare rerun continues the unfinished release. The command:

1. Pins the accepted Dev revision, which must have passed its Dev checks, and
   excludes unfinished work. It creates `release/vX.Y.Z` from that revision, merges
   `main` when Dev does not contain it, and commits the version in the root package
   files and the backend Cargo manifest and lockfile. A merge conflict stops the
   command; resolve and commit it in the release worktree, then rerun.
2. Opens the release PR to `main` and waits for the complete `platform` check. Fix
   failures on the release branch. The owner's release request authorizes this
   release PR merge and publication; it does not authorize unrelated development
   PR merges.
3. Merges, then opens a PR that brings `main` back into `dev` so both branches keep
   shared history and release-branch fixes reach Dev. Its checks run alongside the
   rest of the release and it merges once they pass.
4. Waits for the exact main commit's `Platform checks` run. The release PR already
   ran backend/API, browser UI, native collector, artifact and dependency checks
   on the identical merge tree, so main promotes those tested bytes after a smoke
   check, exactly as Dev does. Without a matching validation main runs every suite.
   The final gate publishes `dispatch-main-<commit>` only after all required jobs pass.
5. Runs `prepare-release.py` into `releases/vX.Y.Z` and smoke tests that extracted
   runtime against disposable state on this machine. Those exact bytes are
   promoted; the published artifact is never rebuilt, on Production or elsewhere.
6. Waits for the release notes in `releases/vX.Y.Z-notes.md`; write them while the
   checks run. It creates a **draft** `vX.Y.Z` targeting the checked main commit with
   `dispatch-platform-X.Y.Z.tar.gz`, `release.json`, `provenance.json` and
   `SHA256SUMS`, verifies GitHub's digest of every uploaded asset against the
   prepared files, and only then publishes it as a stable release. GitHub release
   immutability stays enabled. It never replaces a tag or uses `--clobber`.
7. Waits until the public Production health endpoint reports the released runtime
   digest, checks the dashboard assets, and records `deployment-verification.json`.
   A successful publication alone is not a deployment check; also confirm the
   Production updater, login and dashboard.
8. Removes the merged release and sync branches and worktrees.

## Production

`ssh dispatch-production` connects to the runtime host. Its environment root is
`/home/thepickle/dispatch-platform/public/`:

- `live/`: verified dashboard and Rust binary, `release.json` and build metadata.
- `config/`, `data/`, `dsps/`: independent private configuration and persistent state.
- `management/`: reviewed `update-production.py` and `runtime_artifact.py` installed
  from the release source. Changes to these host tools require an explicit host update.
- `.runtime/previous/`: previous verified runtime retained after a successful update.

For first setup, install the pinned BrowserOS and a root-owned bubblewrap executable
with its narrow AppArmor user-namespace profile. Install the two management scripts
and the `dispatch-production*` systemd user units. Use `setup-production.py` with the
verified archive, exact commit/version, HTTPS origin, owner identity and sandbox
path. It creates a fresh owner login in private `config/initial-owner.json`; it
does not copy Dev accounts or DSP data. Configure the separate Production email
Worker, its random bearer secret and the Production tunnel before starting services.
Enable user lingering so services survive logout and start at boot.

The production email Worker uses `services/cloudflare-mail/wrangler.production.jsonc`,
`invitations@dispatch.dillonlille.com`, and its own `MAIL_TOKEN` secret. Configure
`DISPATCH_PRODUCTION_MAIL_MODE=cloudflare`, `DISPATCH_PRODUCTION_MAIL_WORKER_URL`
and `DISPATCH_PRODUCTION_MAIL_WORKER_TOKEN` in the private systemd environment file.
Never copy Dev mail credentials or the Cloudflare account API token to Production.

`dispatch-production-update.timer` runs every 30 seconds without GitHub credentials.
Anonymous API calls are limited to 60 an hour, so between full checks a tick only
reads the public `releases/latest` redirect. That hint can skip a check that already
finished for the same tag and runtime; a changed tag, and at least every ten
minutes, runs the full Releases API check. Only that verified path can install,
and only a newer published stable version. The updater verifies the tag belongs to `main`, GitHub's archive and
manifest hashes, the complete runtime inventory and its source commit. Drafts,
prereleases, old versions and main merges cannot update Production. GitHub API or
download failures leave the current runtime running.

Activation is serialized, keeps private state in place, stops the app, swaps the
runtime and requires production health with the expected digest. Failure restores
the previous runtime. An interrupted activation is recovered before another update.
A release that failed health is recorded in `data/platform/production-update.json`
and is not retried every two minutes; investigate and publish a corrected version.
The database schema must remain compatible with rollback. Schema changes require
an explicit migration and recovery plan; this updater refuses incompatible schemas.

Verify with `systemctl --user status dispatch-production.service`,
`journalctl --user -u dispatch-production-update.service`, and
`curl --fail https://dispatch.dillonlille.com/api/health`.
Keep private backups and verify development work is preserved on `dispatch-dev`
before removing retired development files from the Production host.
