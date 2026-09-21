# Dev host layout

The live checkout is `/home/thepickle/dispatch-platform/dev`, on branch `dev`.
Development changes belong in isolated worktrees under
`/home/thepickle/dispatch-platform/worktrees`; keep the live checkout clean.

Run `DISPATCH_DEV_HOST=100.120.159.116 npm run dev` in a worktree and open its
printed `Development fixtures` URL. Each launch owns its port, fixture data and
session cookie. Bind only to Tailscale or loopback. `DISPATCH_DEV_PORT` pins a port;
an occupied port fails without replacing another server. Stop only your preview.
Browser results stay in the worktree's `test-results/`.

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
install the reviewed `tooling/systemd/dispatch-dev*` units separately. To explicitly
install or repair management from a clean, activated supporting checkout:

```bash
python3 tooling/update-dev.py --root /home/thepickle/dispatch-platform/dev --install-management
```

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
