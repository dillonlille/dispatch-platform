# Fresh host setup

`setup-dev.py` and `setup-production.py` build the checkout's Rust host manager and
invoke `host setup`. Run from a trusted source checkout. Setup initializes a fresh
owner account and separate state; it never starts services or copies another
host's data. Existing `config`, `data`, `dsps`, management or Production `live`
directories are preserved and cause setup to stop, even if empty.

Dev requires a private, real `dev` directory containing a clean persistent clone
on the current merged `origin/dev`, with its verified artifact at `.build`:

```sh
python3 tooling/setup-dev.py \
  --root /home/operator/dispatch-platform/dev \
  --origin https://dev.example.com \
  --owner-email owner@example.com --first-name First --last-name Last \
  --provider native --sandbox-executable /usr/local/bin/dispatch-bwrap
```

Production requires a private, real `public` directory, a verified release
archive, its full source commit and stable version. The sandbox executable must
be a canonical root-owned file with no group or other write permission:

```sh
python3 tooling/setup-production.py \
  --root /home/operator/dispatch-platform/public \
  --artifact /private/releases/dispatch.tar.gz \
  --commit FULL_RELEASE_COMMIT --version MAJOR.MINOR.PATCH \
  --origin https://dispatch.example.com \
  --owner-email owner@example.com --first-name First --last-name Last \
  --sandbox-executable /usr/local/bin/dispatch-bwrap
```

Origins must be canonical HTTPS origins without a trailing slash or path. Dev
also accepts `--provider fixture`; its sandbox argument is optional. Production
requires the native provider. Direct Rust usage is
`dispatch-host host setup <dev|production> ...` with the same arguments.

Setup holds `.runtime/setup.lock`. It verifies the artifact and stages the manager,
launchers, database, owner credentials and configuration under a private
`.runtime/.setup-*` directory. Bootstrap receives only the setup environment;
the generated password travels over private stdin and child output is suppressed.
The credentials are saved with mode 0600 before account creation.

A journal at `.runtime/setup.json` records progress. Publication moves prepared
state without replacing existing destinations, then publishes `config` last.
`config/initial-owner.json` contains the initial login; do not paste it into logs.
Install the reviewed systemd units separately after setup succeeds.

If interrupted, rerun the identical command. An interruption during bootstrap
restarts only its unpublished staging directory. Once preparation completes,
setup resumes the recorded renames without creating another owner or password.
Changed arguments, modified prepared files, conflicting destinations or an
invalid journal stop recovery and preserve the files for inspection. Do not
remove that journal or the private state to force a retry.

Fresh setup installs all manager files together. Later explicit
`--install-management` operations retain the previous complete installation for
recovery, as described in [the Dev host guide](DEV-HOST.md). After each healthy
activation of a verified release, Production adopts that release's own updater once
it passes a self-check, as Dev does on every check. It never does so on an ordinary
check, so an updater restored by hand stays until the next release, and the previous
release's copy remains in its retained runtime.
