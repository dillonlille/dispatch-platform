# Dispatch Platform

A shared platform for DSP operations. One login and dashboard serve every DSP.
Application code and browser workers are installed centrally; each DSP owns only
private configuration, credentials, browser state, and databases.

**Independent Dev environment.** After explicit host setup, successful merged
`dev` builds automatically update the full test platform. Production setup is deferred.
There is no Plugins page. Paycom is configured on a DSP’s **Connections** page.

## Develop

Requires Node **22.23.2**, npm, Rust via rustup (pinned in `rust-toolchain.toml`),
a C compiler, and Linux for native services and browser workers.

```bash
npm ci --ignore-scripts
npm run dev
```

Open `http://127.0.0.1:5173`. Synthetic development accounts:

| Account                | Password              | Access                     |
| ---------------------- | --------------------- | -------------------------- |
| `owner@dispatch.test`  | `Dispatch-demo-2026!` | Platform owner             |
| `member@dispatch.test` | `Dispatch-demo-2026!` | Northline Logistics member |

These accounts exist only in the explicit fixture seed. Production bootstrap
requires an operator-supplied password on stdin and never creates demo accounts.
The local development runner creates a new temporary state directory and removes
it on shutdown. Installed environments set `DISPATCH_STATE_ROOT` explicitly.

## Repository

```text
dashboard/          React dashboard, responsive layouts, forms and tables
backend/            Rust platform API, BrowserOS Paycom driver, DSPs, jobs and storage
services/browsers/  Archived Node workers retained for artifact compatibility
integrations/paycom/ Retained provider adapter, parsers and worker contracts
shared/             Dashboard/worker contracts and validation helpers
tooling/            Build, updater, fresh-state cutover and developer verification
tests/              Rust API, provider, browser and artifact integration tests
docs/               Architecture, implementation record and design reference
```

The persistent repository is `/home/thepickle/dispatch-platform/dev/live`, tracking
`dev`. Its sibling `config/`, `data/` and `dsps/` directories contain private Dev
state. Feature work uses separate worktrees. The future Production layout is
`public/live` with its own sibling state directories. `archive/` is retained.
See [Dev setup](docs/DEV-SETUP.md) for owner bootstrap, services and access.

## Verify

```bash
npm run check
npm test
python3 -m unittest discover -s tests -p '*_test.py'
npm run build
npm run test:artifact
npm run test:ui
npm run test:native
node tooling/clean-test-output.mjs
```

`test:ui` starts the **built artifact** on loopback port 5190 with disposable
fixtures. It stops that process and removes its data when finished. It requires
Playwright Chromium (`npx playwright install chromium`). `test:browser` targets
an already-running development server. `test:artifact` launches the installed Rust
artifact with an empty platform on a temporary port and checks its inventory.

Native tests use local fixture pages, real Chromium, separate Linux namespaces,
profiles and the private CDP bridge. Host verification with
`npm run test:browser-host` additionally checks Chromium's internal namespace and
seccomp sandboxes without using provider credentials. See the Dev setup guide for
this host's scoped AppArmor configuration. Real Paycom acceptance requires the
owner to configure a Dev DSP connection.

See [DEVELOPMENT.md](DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md),
[security](docs/SECURITY.md), and [RELEASES.md](RELEASES.md).
The [Rust migration](docs/RUST-MIGRATION.md) describes the complete core retirement,
verification, performance measurements and deployment boundaries.
