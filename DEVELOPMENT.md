# Development

## Shared Dev platform

The persistent repository is `/home/thepickle/dispatch-platform/dev/live`, tracking
`dev`. It runs the compiled `.build/` artifact. Configuration is in sibling
`config/`, platform state in `data/`, and private DSP state in `dsps/`. This is an
independent platform with its own login, owner dashboard, Dev DSP and test DSPs.
Nothing depends on a Production account registry or gateway.

Use isolated feature worktrees from `dev`; target PRs at `dev`. The owner gives
standing approval to merge completed feature PRs after reviewing the submitted
head and passing checks, unless they ask to hold a PR. After a verified merge, remove the clean feature
worktree and local/remote feature branch, preserving any unmerged work. Never
delete `dev`, `main`, or the persistent environment checkout.

Successful **push checks on dev** upload a compiled artifact identified by the
commit SHA. A user-systemd timer checks every 10 seconds. It installs only the artifact
for the current merged `dev` head, after verifying the GitHub download digest,
runtime inventory and source commit. PR build artifacts and failed/pending checks cannot
update the environment. Unfinished edits in the running checkout block updates.

PR checks run independent suites concurrently on one runner. A change consisting
only of dashboard stylesheets runs TypeScript, formatting, a complete build and
all dashboard browser tests. Other changes run the full suite, including unit,
dependency, artifact/rollback and Python checks. Unknown changes use the full path.

A successful same-repository PR publishes a small validation receipt containing
its base/head commits, complete Git tree and check scope. A merge to `dev` reuses
those results only when all three revisions match, the latest PR workflow passed,
and the receipt's GitHub archive digest and run attempt match. Missing, expired,
failed or mismatched evidence falls back to normal checks. This never installs a
PR build: the merged commit gets a fresh verified build and a smoke check covering
standalone startup, health/digest, dashboard assets, login, DSP access and Paycom
settings. The existing updater still requires a successful merged-dev workflow.

Manual checks and release checks always run the full suite. A host timer dispatches
full `dev` checks nightly at 04:00 UTC, independently of deployment checks. This
works while `main` remains the GitHub default branch. Nightly/manual runs do not
publish deployable artifacts or cancel a running push workflow.

The updater stops Dev, swaps `.build/`, fast-forwards the source checkout, starts
Dev and verifies its health/digest. A failed start restores the previous code and
checkout. Accounts, configuration, credentials, DSP data and browser profiles stay
in place. An interrupted activation is recovered on the next updater run. Changes
to database schemas must preserve compatibility with the previous build; code
rollback does not reverse data migrations.

First setup and operating commands are in [Dev setup](docs/DEV-SETUP.md).

## Feature development and fixtures

Inside a feature worktree:

Install Rust via rustup (including its PATH setup) and a C compiler. The pinned
toolchain is selected automatically; `npm run dev` compiles the Rust service first.

```bash
npm ci --ignore-scripts
npm run dev
```

This optional local runner starts Vite at `http://127.0.0.1:5173` and a fixture API
on 5180. Use a free API port via `PORT` and adjust the Vite proxy when the hosted
Dev service occupies 5180. It seeds synthetic accounts/DSPs in a temporary state
root; never point the fixture runner at the persistent Dev state. Frontend edits
hot reload; restart this local API runner after backend changes. Feature work does
not change the shared Dev environment before merge.

`npm run build` writes the deployable artifact to `.build/`. It bundles the API and browser workers,
compiles the Rust backend (using Cargo's ignored `target/` cache),
installs locked runtime dependencies, records the source commit, and produces the
SHA-256 `release.json` inventory. Building alone does not activate it.

Stop temporary servers before cleanup. Verification scripts remove their own
temporary state; `node tooling/clean-test-output.mjs` removes known reports and
screenshots. Remove only your own `/tmp` artifacts.

## Verification

Keep local feedback proportional to the change. For a cosmetic fix, build once,
inspect the affected flow on desktop/mobile, and reuse the existing browser tests;
do not write a new browser harness or repeat the full suite already running in CI
without a specific failure or concern. Forward Playwright filters to the built
fixture runner, for example:

```bash
npm run build
npm run test:ui -- tests/browser/dashboard.spec.ts --grep 'archived Paycom settings'
```

For pipeline/backend changes, `npm run check:ci -- full` runs independent checks
concurrently. `npm run test:smoke` exercises a fresh standalone fixture without
starting a browser. The individual verification commands remain available:

```bash
npm run check
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm run format:check
npm test
python3 -m unittest discover -s tests -p '*_test.py'
npm run build
npm run test:artifact
npm run test:ui
npm run test:native
```

Checks cover login/role/CSRF boundaries, independent Dev accounts, provisioning,
encrypted credentials, collection jobs, schedules, backups, archive verification,
dirty-checkout protection, activation and rollback. Browser checks exercise the
built dashboard/API together. Native verification uses local fixture pages and
isolated Chromium profiles; real provider acceptance requires user-supplied DSP
credentials. Legacy gateway/supervisor tests remain for compatibility and do not
install or start Production.

Update contracts and their producers/consumers together. Validate provider results
before publication and preserve the last successful dataset on failure. Never
accept a filesystem path from a DSP request. Collection workers receive no platform
state root, vault path or other DSP's profile.
