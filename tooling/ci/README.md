# CI tooling

One run per change, in the merge queue, on the exact squash commit the queue will push. Every
suite runs every time; nothing runs on the PR itself. `.github/workflows/checks.yml` is the
whole pipeline, and `tooling/ci/checks.ts` runs one of its jobs by name, or locally the whole
suite in sequence:

| Job             | `npm run check:ci -- …`                    | What it proves                                                    |
| --------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| build           | `build`                                    | The runtime packages: the release backend and the dashboard.      |
| checks          | `checks`                                   | Types, formatting, the bundle budget, the dashboard logic tests.  |
| browser ×8      | `browser <n>/8 [spec]`                     | The browser suite against the packaged runtime.                   |
| smoke           | `smoke`                                    | The package starts, signs in and serves, as a release asks.       |
| benchmark       | `benchmark`                                | The Rust workload budget.                                         |
| core            | `core`                                     | Rust formatting, lints and tests.                                 |
| api             | `api`                                      | The API tests, the Python tooling tests, the npm audit.           |
| collectors ×4   | `npm run test:browseros -- --shard <name>` | The native collectors with a real browser.                        |
| rust-advisories |                                            | `cargo audit`.                                                    |
| platform        |                                            | The gate: the one required check.                                 |
| report          |                                            | A failed queue run's jobs and first failure, commented on its PR. |

The gate passes only when every job passed. It then verifies the package's inventory and
source commit (`ci-verify.py`, which runs `dispatch-host ci verify`) and publishes it as
`dispatch-main-<sha>` for 90 days. The Dev updater installs that build, and a release stamps
its version into it. A manual run of one suite has no gate, so nothing partial is published;
the release tool accepts only runs whose `core` and `platform` jobs succeeded.

When a queue run fails, GitHub removes the PR with a one-line timeline event and nothing that
leads to the run. The `report` job then posts one comment on the PR (`queue-report.py`): the
squash commit tested and the `main` commit it sat on, each failed job with the step it failed
at and a link to its log, and the first failure's output from the first failed job's log, from
its first failure marker (a Playwright, unittest, Cargo, TAP, rustc or npm failure line) and
otherwise the lines before the runner's error. A second failure, or a failed rerun, gets a
comment of its own, naming its attempt.

The ruleset expects the `platform` check on a PR head before the queue admits it, so
`queue-admission.yml` reports one on every PR head, usually within a minute. It proves
nothing; the queue's own gate decides, and a PR queued before it passed is dropped as an
invalid merge commit.

`backend/ci` builds as `dispatch-ci` and holds what runs on this machine: the Rust build
cache and compiler fingerprint (`cargo-build.py`), the PR preflight (`npm run pr:prepare`) and
the ship command. `npm run pr:ship -- <number>` reads the PR from GitHub's API every 20
seconds, adds it to the merge queue once its admission check passed and GitHub knows it merges
cleanly, and waits until GitHub merges it, printing the squash commit. A newer push is queued
in its turn. It stops with the reason when the PR conflicts with `main`, is a draft, closes,
leaves the queue unmerged, with GitHub's reason and the failed jobs of its own queue run, or
has not merged after 90 minutes.

Caches: only `main`'s reach every branch, since the queue's branches are deleted after each
run. `caches.yml` refreshes them on every push to `main`: the release backend keyed by its
inputs, the CI and host tools, the assessment fixture, the Playwright browser and the
BrowserOS package. A run's own `tools` job builds what its inputs lack for the jobs that start
later in that run. Launchers use a restored tool only on CI and only from the workspace's own
`.ci-tools` directory; otherwise they build with Cargo.

Run the tests with:

```sh
cargo test --locked -p dispatch-ci -p dispatch-host
python3 -m unittest discover -s tests/tooling -p '*_test.py'
```
