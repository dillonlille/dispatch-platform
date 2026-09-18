# Dev host layout

The live checkout is `/home/thepickle/dispatch-platform/dev`, on branch `dev`.
Development changes belong in isolated worktrees under
`/home/thepickle/dispatch-platform/worktrees`; keep the live checkout clean.

- `.build/`: verified compiled runtime serving https://dispatchdev.dillonlille.com.
- `config/`, `data/`, `dsps/`: private environment configuration and persistent state.
- `.runtime/management/`: installed host updater, independent of source checkout changes.
- `.runtime/previous/`: runtime retained for failed-update rollback.

Private state is ignored by Git. The updater also retains local Git exclusions
across rollback to older commits, and rejects source commits that track these
reserved paths. Keep state out of runtime archives.

For a fresh installation, clone the repository directly into `dev/` and follow
`tooling/setup-dev.py` with a verified `.build` artifact. Setup installs the host
updater. Install the reviewed `tooling/systemd/dispatch-dev*` units separately.

For a reviewed host-updater change on an existing installation, run the updated
source script on dispatch-dev:

```bash
python3 tooling/update-dev.py --root /home/thepickle/dispatch-platform/dev --install-management
```

The service units execute the installed copy in `.runtime/management/`, so a source
rollback cannot restore old path assumptions. Host-updater changes require this
explicit installation step. Private state paths and the Cloudflare tunnel
configuration do not change when moving an older `dev/live` checkout into `dev`.

Verify the checkout and installed runtime with:

```bash
python3 /home/thepickle/dispatch-platform/dev/.runtime/management/update-dev.py --root /home/thepickle/dispatch-platform/dev --verify
systemctl --user status dispatch-dev.service dispatch-dev-update.timer
curl --fail https://dispatchdev.dillonlille.com/api/health
```
