# Independent Dev setup

These steps explicitly set up Dev on this host. They create no Production runtime.
The persistent repository must already be at `dev/live/`, tracking merged `dev`.
Use a clean checkout and a verified `.build/` artifact for that exact commit.

```text
/home/thepickle/dispatch-platform/
  dev/live/                         Git repository and .build runtime
  dev/config/platform.env           Private process configuration
  dev/config/updater.json            Dev service and local health address
  dev/config/initial-owner.json      Private generated first-login details
  dev/data/platform/accounts.sqlite Owner/users/memberships/DSP registry
  dev/data/platform/platform.key     Platform signing/encryption key
  dev/data/preview/jobs.sqlite       Dev job queue
  dev/dsps/dsp_<id>/                 Individual DSP config/data/secrets/browser state
  dev/worktrees/                    Temporary feature worktrees
  archive/                          Retained previous platform
```

## Initialize

Requirements: a verified Rust artifact, Node 22.23.2 for isolated browser workers at `~/.local/bin/node`, Python 3, Git, authenticated `gh`
at `~/.local/bin/gh`, user systemd with lingering, and an HTTPS endpoint. Native
provider connections also need compatible Chromium/bubblewrap isolation. Building
from source requires the pinned Rust toolchain and a C compiler. The installed
platform service runs the Rust binary directly; it needs no Cargo or Node API.

From the merged repository, after building/verifying the exact commit:

```bash
python3 tooling/setup-dev.py --root /home/thepickle/dispatch-platform/dev --origin https://dispatchdev.dillonlille.com --owner-email you@example.com --first-name Your --last-name Name
```

The setup refuses an existing account database/configuration. It creates a platform
owner and permanent Dev DSP, using a randomly generated password stored only in
`config/initial-owner.json`. Change the password through Account after signing in
and remove that initial-login file. Never commit or paste it into a PR.

`--provider fixture` explicitly selects synthetic provider data. Native is the
default. Both run the compiled application with secure cookies and their own
account database. Dev email is always captured privately in
`data/platform/development-mail/`; it is not sent externally.

After reviewing the units, copy the reviewed `tooling/systemd/dispatch-dev*` units into
`~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then enable/start
`dispatch-dev.service`, `dispatch-dev-update.timer` and `dispatch-dev-checks.timer`.
The checks timer uses authenticated `gh` to dispatch the full `dev` workflow at
04:00 UTC daily. The units use port 5180 on
loopback; they do not expose a public network listener.

For this host, `dispatch-dev-tunnel.service` runs a dedicated Cloudflare Tunnel
with private `config/cloudflared.yml` and `config/cloudflare-tunnel.json`. Its only
hostname is `dispatchdev.dillonlille.com`, forwarded to `http://127.0.0.1:5180`;
other hostnames return 404. Create the tunnel/route only during requested setup.
The tunnel credential and origin certificate must never enter Git or build artifacts.

### Native browser host

The archived Paycom flow needs root-owned Chrome, `/usr/bin/Xvfb`,
`/usr/bin/python3`, and `/usr/bin/setpriv`, plus X11/XTest libraries (Ubuntu packages
`xvfb`, `python3`, `util-linux`, `libx11-6`, and `libxtst6`). Native PIN entry uses a
private Xvfb display; the host check verifies actual keyboard/mouse input as well
as both layers of sandboxing. No graphical desktop or per-DSP installation is needed.

Paycom verification uses an interactive window in the dashboard. The user solves
the CAPTCHA and presses Submit to resume login. No bot or model configuration is needed.

Ubuntu's generic bubblewrap AppArmor profile strips capabilities needed by nested
Chromium namespaces. The Dev-specific host configuration uses the same installed
bubblewrap binary copied to a root-owned path, with a narrowly attached profile:

```bash
sudo install -d -o root -g root -m 755 /usr/local/libexec/dispatch-dev
sudo install -o root -g thepickle -m 750 /usr/bin/bwrap /usr/local/libexec/dispatch-dev/bwrap
sudo install -o root -g root -m 644 tooling/host/dispatch-dev-bwrap.apparmor /etc/apparmor.d/dispatch-dev-bwrap
sudo apparmor_parser -r /etc/apparmor.d/dispatch-dev-bwrap
DISPATCH_BWRAP_EXECUTABLE=/usr/local/libexec/dispatch-dev/bwrap npm run test:browser-host
```

After this check passes, supply
`--sandbox-executable /usr/local/libexec/dispatch-dev/bwrap` to setup. The system-wide
user-namespace restriction is unchanged. Outer worker mounts/network/PID isolation
and Chromium's inner namespace/seccomp sandboxes remain enabled. Refresh the
root-owned binary copy when the system bubblewrap package receives updates.

## Operate

```bash
systemctl --user status dispatch-dev.service dispatch-dev-update.timer dispatch-dev-checks.timer
journalctl --user -u dispatch-dev.service -u dispatch-dev-update.service -n 80
systemctl --user start dispatch-dev-update.service
```

The updater checks every 10 seconds and waits for successful GitHub checks. Dev builds
are shown on the dashboard's Releases page. The same PR can be edited/tested in a
feature worktree without affecting the running platform until merge.

The first build is installed during this explicit setup. Subsequent builds come
from the GitHub artifact published by `checks.yml` for a push to `dev`. A failed
build/check/start leaves or restores the last working version. Update receipts and
status live under `data/platform/`; only `.build/` and the source checkout change.

To apply timer changes on an existing installation, copy only the reviewed unit
files from the merged checkout into `~/.config/systemd/user/`, run
`systemctl --user daemon-reload`, restart `dispatch-dev-update.timer`, and enable
`dispatch-dev-checks.timer`. Changing the repository copy alone does not update
the installed timers. Manual full validation is also available with
`gh workflow run checks.yml --repo dillonlille/dispatch-platform --ref dev`.

Do not run `npm run dev`, reset Git, or rebuild `.build/` in the persistent checkout
while the shared Dev service is running. Use feature worktrees for local edits.
Stop the updater timer before deliberate configuration, backup or maintenance.

## Fresh-state cutover from the Node core

This one-time operation **erases existing Dev accounts, DSPs, jobs, credentials,
and browser profiles** after the fresh Rust instance passes verification. The
initial owner's email and name are retained for a newly created owner account;
its password is regenerated. The resulting platform has one empty permanent Dev
DSP and no seeded demo data. Archive, Production, tunnel and host configuration
are outside the reset scope.

After explicit authorization to discard Dev data, merge and wait for successful
merged-dev checks, then run the reviewed tool from an isolated checkout:

```bash
python3 tooling/migrate-rust-dev.py --root /home/thepickle/dispatch-platform/dev --reset-data
```

It downloads the verified GitHub artifact for the current merged `dev` head,
bootstraps empty state privately before stopping Dev, installs the direct Rust
service unit, and checks health, login, the empty DSP, jobs and connection state.
Only then does it erase old state and write new private login details to
`dev/config/initial-owner.json`. It preserves `platform.env`, tunnel settings and
unrelated host configuration. The normal updater cannot cross schema 2 to 3.

If interrupted, recover using the same reviewed tool:

```bash
python3 tooling/migrate-rust-dev.py --root /home/thepickle/dispatch-platform/dev --recover
```

A receipt in `live/.runtime/rust-reset-receipt.json` survives data replacement.
Before verification completes, recovery restores the old code, service unit, data
and initial credentials. After completion, recovery only finishes cleanup; it
cannot bring retired data back. No normal updates run while this receipt exists.

For read-only inspection while the service is running, load `platform.env` and use
`live/.build/services/rust/dispatch-backend status`. Backup/restore commands require
the service and updater timer to be stopped; see [Releases](../RELEASES.md).
