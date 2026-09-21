# CI policy

`backend/ci` owns conservative check selection, PR validation receipts and the
required-job gate. It builds as `dispatch-ci` in the debug profile so the planner
can start inside its existing three-minute job budget without compiling the host
manager's networking stack. The existing `ci-plan.py` and `ci-gate.py` command
paths are bootstrap adapters. Cargo selects the configured target directory.

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
and source fingerprint equals the key recorded by the PR. `cargo-build.py`
continues to own build bootstrap and fingerprint calculation.

Run policy and promotion tests with:

```sh
cargo test --locked -p dispatch-ci -p dispatch-host
python3 -m unittest discover -s tests/tooling -p '*_test.py'
```

The final `platform` job requires every expected job result, including every
collector shard and Rust advisories. Artifact publication still happens only
after that gate succeeds. Draft PRs produce no validation receipt.
