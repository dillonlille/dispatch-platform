# Dev host layout

The live checkout is `/home/thepickle/dispatch-platform/dev`, on branch `main`. Its
updater installs each commit merged into `main` once that push's checks pass.
Development changes belong in isolated worktrees under
`/home/thepickle/dispatch-platform/worktrees`; keep the live checkout clean.

Run `DISPATCH_DEV_HOST=100.120.159.116 npm run dev` in a worktree and open its
printed `Development fixtures` URL. Each launch owns its port, fixture data and
session cookie. Bind only to Tailscale or loopback. `DISPATCH_DEV_PORT` pins a port;
an occupied port fails without replacing another server. Stop only your preview.
Browser results stay in the worktree's `test-results/`.

A preview that must outlive its session runs as `dispatch-preview@<worktree>.service`,
which pins the same port through `~/.config/dispatch-preview/<worktree>.env`:

```sh
install -Dm600 /dev/stdin ~/.config/dispatch-preview/my-branch.env <<<'DISPATCH_DEV_PORT=4101'
systemctl --user start dispatch-preview@my-branch
systemctl --user status dispatch-preview@my-branch   # the link is in its output
```

It keeps everything it makes, including its fixture data, in the worktree's scratch
directory `/tmp/dispatch-my-branch`. When its PR merges, stop it with
`systemctl --user stop dispatch-preview@my-branch`, then remove the env file and that
directory. The unit never restarts on its own: a crashed preview stays down instead of
looping on a broken branch.

- `.build/`: verified compiled runtime serving https://dispatchdev.dillonlille.com.
- `config/`, `data/`, `dsps/`: private configuration and persistent state.
- `.runtime/management/`: installed Rust manager and compatibility launchers.
- `.runtime/previous/`: runtime retained for failed-update rollback.

`backend/host` owns artifact verification, downloads, activation and recovery.
Build and CI invoke a manager compiled from their checkout. Host services invoke
an installed copy of the verified runtime binary with `host dev` commands;
management survives replacement or rollback of both `.build` and tracked source.
Never use a downloaded candidate as its own verifier.

Existing systemd units keep calling `update-dev.py`. That launcher delegates to
`.runtime/management/dispatch-host`. On the first upgrade from Python, the old
updater verifies and activates the new artifact, then installs the launchers.
Their bootstrap verifier copies the Rust manager only from the completed, healthy
activation named by the receipt. Subsequent Dev updates refresh the manager after
successful activation; a failed self-check retains the working manager.

Artifact format 3, schema 3, activation receipts and private-state exclusions stay
compatible. A rollback to a runtime predating Rust management keeps the installed
manager. Service startup runs `--verify`; management drift never blocks recovery.

For fresh setup, use `tooling/setup-dev.py` with a verified `.build` artifact, then
install the reviewed `tooling/systemd/dispatch-dev*` units separately. Both setup
launchers delegate to `host setup`; see [fresh host setup](HOST-SETUP.md) for
arguments and recovery. To explicitly
install or repair management from a clean, activated supporting checkout:

```bash
python3 tooling/update-dev.py --root /home/thepickle/dispatch-platform/dev --install-management
```

Explicit installation verifies the active runtime and self-checks a staged manager,
then atomically replaces the complete manager/launcher directory under the updater
lock. An existing installation is retained at
`.runtime/.management-install-*/previous-management` for manual recovery. Automatic
Dev refresh continues to replace only the verified manager executable.

Verify the runtime and installed manager:

```bash
python3 .runtime/management/update-dev.py --root "$PWD" --verify
python3 .runtime/management/update-dev.py --root "$PWD" --verify-management
systemctl --user status dispatch-dev.service dispatch-dev-update.timer
curl --fail https://dispatchdev.dillonlille.com/api/health
```

Production uses `host production` through `management/update-production.py` and
an independent installed manager. Its host installation requires explicit
Production authorization; publishing a runtime release does not replace it.
