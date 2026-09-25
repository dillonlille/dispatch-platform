# CI tooling

One run per change, in the merge queue, on the exact squash commit the queue will push. Every
suite runs every time; nothing runs on the PR itself. `.github/workflows/checks.yml` is the
whole pipeline, and `tooling/ci/checks.ts` runs one of its jobs by name, or locally the whole
suite in sequence:

| Job             | `npm run check:ci -- …`                    | What it proves                                                   |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| build           | `build`                                    | The runtime packages: the release backend and the dashboard.     |
| checks          | `checks`                                   | Types, formatting, the bundle budget, the dashboard logic tests. |
| browser ×8      | `browser <n>/8 [spec]`                     | The browser suite against the packaged runtime.                  |
| smoke           | `smoke`                                    | The package starts, signs in and serves, as a release asks.      |
| benchmark       | `benchmark`                                | The Rust workload budget.                                        |
| core            | `core`                                     | Rust formatting, lints and tests.                                |
| api             | `api`                                      | The API tests, the Python tooling tests, the npm audit.          |
| collectors ×4   | `npm run test:browseros -- --shard <name>` | The native collectors with a real browser.                       |
| rust-advisories |                                            | `cargo audit`.                                                   |
| platform        |                                            | The gate: the one required check.                                |

The gate passes only when every job passed. It then verifies the package's inventory and
source commit (`ci-verify.py`, which runs `dispatch-host ci verify`) and publishes it as
`dispatch-main-<sha>` for 90 days. The Dev updater installs that build, and a release stamps
its version into it. A manual run of one suite has no gate, so nothing partial is published;
the release tool accepts only runs whose `core` and `platform` jobs succeeded.

The ruleset expects the `platform` check on a PR head before the queue admits it, so
`queue-admission.yml` reports one on every PR head within seconds. It proves nothing; the
queue's own gate decides.

`backend/ci` builds as `dispatch-ci` and holds what runs on this machine: the Rust build
cache and compiler fingerprint (`cargo-build.py`), the PR preflight (`npm run pr:prepare`) and
the ship command. `npm run pr:ship -- <number>` adds the PR to the merge queue at once and
reads it from GitHub's API every 20 seconds until GitHub merges it, printing the squash commit.
A newer push is queued in its turn. It stops with the reason when the PR is a draft, closes,
leaves the queue unmerged, naming the failed jobs of its queue run, or has not merged after 90
minutes.

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
