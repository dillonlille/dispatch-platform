# Dispatch releases

Development lives on `dispatch-dev`. Its `/home/thepickle/dispatch-platform/dev` checkout tracks `dev`; passing
checks for the current merged revision install the verified Dev artifact. Keep
unfinished work in separate worktrees. Production contains an installed runtime,
private state and management scripts; it needs neither a Git checkout nor build tools.

## Prepare a release

1. Choose an unused stable `X.Y.Z`. Existing tags and release assets are immutable.
   Pin the accepted Dev revision; exclude unfinished work. Create a release branch
   containing that revision and the release tooling from `main`, and update the
   root package files and backend Cargo version/lockfile.
2. Open a release PR to `main`. Require the complete `platform` check and review
   the source. The owner's release request authorizes this release PR merge and
   publication; it does not authorize unrelated development PR merges.
3. After merging, wait for the exact main commit's `Platform checks` run. It runs
   backend/API, browser UI, native collector, artifact and dependency checks. The
   final gate publishes `dispatch-main-<commit>` only after all required jobs pass.
4. On `dispatch-dev`, run
   `python3 tooling/prepare-release.py --commit <main-sha> --version X.Y.Z --output <private-new-directory>`.
   Test the extracted runtime in a disposable environment on this machine. Promote
   those exact bytes; never rebuild the published artifact on Production.
5. Enable GitHub release immutability. Create a **draft** `vX.Y.Z` targeting the
   checked main commit with `dispatch-platform-X.Y.Z.tar.gz`, `release.json`,
   `provenance.json`, `SHA256SUMS` and release notes. Verify each uploaded digest
   against the prepared files. Publish the draft as a stable release only after
   validation. Never replace an existing tag or use `--clobber`.
6. Confirm the Production updater, public health endpoint, runtime version/digest,
   login and dashboard. A successful publication alone is not a deployment check.

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

`dispatch-production-update.timer` checks the public GitHub Releases API every two
minutes without GitHub credentials. Only a newer published stable version can
install. The updater verifies the tag belongs to `main`, GitHub's archive and
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
