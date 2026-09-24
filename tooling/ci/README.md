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
PRs into `main`, its merge queue groups and its pushes are scoped by what they change
and reuse a matching receipt. Any other branch is validated in full. A release
separately requires the full suite on the exact commit it publishes. API failures
fall back to ordinary check selection.

A receipt binds the same-repository PR merge's base, head and tree, workflow,
run and attempt, target branch and validation scope. The newest matching run
wins even when it failed, is pending or was skipped. Receipt ZIP size, entry,
JSON and GitHub digest are verified before reuse.

A merge queue on `main` runs the workflow on the exact merge commit it will push,
scoped against the group's base so every PR in the group counts. A group holding one
PR that is still current with `main` merges the same base, head and tree that PR's own
run validated, so it reuses that run's gated build and only smoke tests it, and its
receipt records that run's scope. A batched group, a group built on another base and
a stale PR are validated afresh. That run issues the receipt and gated build, and the
following `main` push looks for it first: the newest merge queue run of the pushed
commit decides, and only a commit with no queue run falls back to its PR head's run.
The preflight stops treating a moved `main` or other ready PRs as blockers while the
queue exists.

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

The fingerprint names the Rust compiler, C compiler and linker by version and the
runner's distribution, not its weekly image build, so an image rollout that runs two
builds side by side does not split the cache in half.

Local worktrees share at most eight recently used entries under Git's common
`dispatch-rust-builds` directory. Each restored binary is a separate copy. Pruning
skips locked entries; readers recheck lock identity after concurrent pruning.
Custom build scripts, Cargo configuration, compiler overrides and dependencies
outside `backend` disable reuse. CI reuse additionally requires the explicit
`.ci-rust-cache` path and the selected key to match current inputs.

`npm run pr:prepare` checks the feature branch, committed changes, fetched Dev
ancestry and other ready PRs through Rust. `--allow-concurrent` retains the
explicit override for intentional overlapping work.

`npm run pr:ship -- <number>` ships an open PR. It reads the PR from GitHub's API every
20 seconds: once the checks on its current head pass, including the required `platform`
gate, it adds the PR to the merge queue bound to that head, then waits until GitHub
merges it and prints the merge commit. A newer push is followed to its own checks. It
stops with the reason when a check fails, with each failed check's name and link, and
when the PR is a draft, closes, leaves the queue unmerged or has not merged after 90
minutes. Brief API failures are retried; a PR it cannot read at all stops it at once.

Run policy and promotion tests with:

```sh
cargo test --locked -p dispatch-ci -p dispatch-host
python3 -m unittest discover -s tests/tooling -p '*_test.py'
```

The final `platform` job requires every expected job result, including every
browser shard, every collector shard and Rust advisories. The build job packages
its build for every run; four `browser` jobs, three workers each, test those exact
bytes in parallel while `core` and the collectors run, and reuse runs skip them.
The build job names that artifact after its own attempt and passes the name as an
output, so rerunning only failed jobs still finds the bytes it uploaded. Artifact publication still happens only
after that gate succeeds. Draft PRs produce no validation receipt.

`.github/actions/setup-tools` restores `dispatch-ci`, `dispatch-host` and the browser
assessment fixture that a trusted branch built from identical inputs, keyed by the Rust
inputs, the pinned toolchain and the runner's distribution. Launchers use a restored tool only on
CI and only from the workspace's own `.ci-tools` directory; otherwise they build with
Cargo exactly as before. Only the `tools` job on `main` pushes saves those
caches, and the pinned Playwright browser, off the critical path.
