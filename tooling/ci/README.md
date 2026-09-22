# CI policy

`backend/ci` owns conservative check selection, PR validation receipts and the
required-job gate, Rust build cache and PR preflight. It builds as `dispatch-ci` in the debug profile so the planner
can start inside its existing three-minute job budget without compiling the host
manager's networking stack. The existing `ci-plan.py`, `ci-gate.py`, `cargo-build.py` and
`ci/pr-prepare.py` paths are bootstrap adapters. Cargo selects the configured target directory.

The planner chooses full validation for backend, shared, infrastructure or
unknown changes. Dashboard code, listed dashboard tests, browser TypeScript and
Markdown outside the backend can use dashboard validation. `test-plan.json`
remains the shared list of executed dashboard tests. Renames count both paths.
Release PRs and main pushes require full validation unless they can reuse a
matching full receipt. API failures fall back to ordinary check selection.

A receipt binds the same-repository PR merge's base, head and tree, workflow,
run and attempt, target branch and validation scope. The newest matching run
wins even when it failed, is pending or was skipped. Receipt ZIP size, entry,
JSON and GitHub digest are verified before reuse.

`backend/host/src/ci` promotes builds through that same receipt policy and the
host artifact verifier. It checks the artifact's GitHub record, file inventory
and original source commit, changes only commit metadata, then rechecks PR
validation before publishing the candidate. Existing destinations are never
replaced. An unavailable build falls back to compilation only after confirming
validation again; revoked or unavailable validation fails the job because other
suites may already have been skipped.

A promoted binary seeds the Rust build cache only when Cargo's current compiler
and source fingerprint equals the key recorded by the PR. Fingerprints, cache
eligibility, atomic copies, digest checks, locking and pruning live in
`backend/ci/src/cache`. The fingerprint includes embedded manager launchers,
Rust sources, schemas, provider scripts, Cargo inputs, compiler identity and
compiler environment. Schema 3 deliberately invalidates Python-era cache keys.

Local worktrees share at most eight recently used entries under Git's common
`dispatch-rust-builds` directory. Each restored binary is a separate copy. Pruning
skips locked entries; readers recheck lock identity after concurrent pruning.
Custom build scripts, Cargo configuration, compiler overrides and dependencies
outside `backend` disable reuse. CI reuse additionally requires the explicit
`.ci-rust-cache` path and the selected key to match current inputs.

`npm run pr:prepare` checks the feature branch, committed changes, fetched Dev
ancestry and other ready PRs through Rust. `--allow-concurrent` retains the
explicit override for intentional overlapping work.

Run policy and promotion tests with:

```sh
cargo test --locked -p dispatch-ci -p dispatch-host
python3 -m unittest discover -s tests/tooling -p '*_test.py'
```

The final `platform` job requires every expected job result, including every
collector shard and Rust advisories. Artifact publication still happens only
after that gate succeeds. Draft PRs produce no validation receipt.

`.github/actions/setup-tools` restores `dispatch-ci`, `dispatch-host` and the browser
assessment fixture that a trusted branch built from identical inputs, keyed by the Rust
inputs, the pinned toolchain and the runner image. Launchers use a restored tool only on
CI and only from the workspace's own `.ci-tools` directory; otherwise they build with
Cargo exactly as before. Only the `tools` job on `dev` and `main` pushes saves those
caches, and the pinned Playwright browser, off the critical path.
