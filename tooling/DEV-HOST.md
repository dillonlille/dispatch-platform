# Dev host layout

The live checkout is `/home/thepickle/dispatch-platform/dev`, on branch `dev`.
Development changes belong in isolated worktrees under
`/home/thepickle/dispatch-platform/worktrees`; keep the live checkout clean.

- `.build/`: verified compiled runtime serving https://dispatchdev.dillonlille.com.
- `config/`, `data/`, `dsps/`: private environment configuration and persistent state.
- `.runtime/management/`: installed host updater, following the activated checkout.
- `.runtime/previous/`: runtime retained for failed-update rollback.

Private state is ignored by Git. The updater also retains local Git exclusions
across rollback to older commits, and rejects source commits that track these
reserved paths. Keep state out of runtime archives.

For a fresh installation, clone the repository directly into `dev/` and follow
`tooling/setup-dev.py` with a verified `.build` artifact. Setup installs the host
updater. Install the reviewed `tooling/systemd/dispatch-dev*` units separately.

The service units execute the installed copy in `.runtime/management/`
(`update-dev.py` and the `runtime_artifact.py` it imports), so rolling a failed
update's source back never changes the updater performing the recovery.

The updater keeps that copy identical to `tooling/` of the live checkout: at the
start of every run and after each successful activation it installs the files of
the clean, activated checkout, once they start on this host. A copy installed by
hand from anywhere else is replaced on the next run. `--verify` fails when the
installed copy differs from the checkout.

An installed updater older than this behaviour does not refresh itself. Install
the current one once from the live checkout on dispatch-dev; the same command
repairs a reported difference:

```bash
cd /home/thepickle/dispatch-platform/dev
python3 tooling/update-dev.py --root /home/thepickle/dispatch-platform/dev --install-management
```

Verify the checkout and installed runtime with:

```bash
python3 /home/thepickle/dispatch-platform/dev/.runtime/management/update-dev.py --root /home/thepickle/dispatch-platform/dev --verify
systemctl --user status dispatch-dev.service dispatch-dev-update.timer
curl --fail https://dispatchdev.dillonlille.com/api/health
```
