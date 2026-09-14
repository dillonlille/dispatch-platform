# Dispatch Platform

A shared platform for DSP operations. One login and dashboard serve every DSP.
Application code and browser workers are installed centrally; each DSP owns only
private configuration, credentials, browser state, and databases.

**Repository rebuild only. Nothing deploys on install, build, push, or merge.**
There is no Plugins page. Paycom is configured on a DSP’s **Connections** page.

## Develop

Requires Node **22.23.2**, npm, and Linux for native browser workers.

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
Development state defaults to `/tmp/dispatch-development-<uid>`; set
`DISPATCH_STATE_ROOT` to a separate private directory to choose another location.
Stop the development runner with Ctrl+C before removing its state directory.

## Repository

```text
dashboard/          React dashboard, responsive layouts, forms and tables
api/                HTTP API, signed DSP views, Preview gateway, server entrypoint
services/
  accounts/         Accounts, sessions, invitations, password recovery, mail outbox
  dsps/             Provisioning, memberships, settings, suspension
  auth-broker/      Per-DSP credential vault and provider authentication
  browsers/         Private browser and collection workers, leases and egress
  jobs/             Durable queue, schedules, retries, cancellation and recovery
  releases/         Artifact verification, activation plans, promotion and rollback
  storage/          SQLite schemas, private paths, locks, backup and restore
  audit/            Platform and DSP activity records
integrations/paycom/ Provider adapter, validated workforce publication, fixtures
shared/             Contracts, errors and cryptography
tooling/            Development, build, operator CLI, supervisor, verification
tests/              Service, security, browser, Preview and artifact integration tests
docs/               Architecture, implementation record and design reference
```

The repository is `/home/thepickle/dispatch-platform/dev` directly. The future
working platform will use `/home/thepickle/dispatch-platform` directly, with
`preview/`, `dsps/`, `local/`, and retained `archive/` alongside the centrally
installed code. There is no `live/` directory and no nested repository directory.

## Verify

```bash
npm run check
npm test
npm run build
npm run test:artifact
npm run test:ui
npm run test:native
node tooling/clean-test-output.mjs
```

`test:ui` starts the **built artifact** on loopback port 5190 with disposable
fixtures. It stops that process and removes its data when finished. It requires
Playwright Chromium (`npx playwright install chromium`). `test:browser` targets
an already-running development server. `test:artifact` exercises two temporary
API processes on ports 5200/5201 and a supervisor entirely under `/tmp`.

Native tests use local fixture pages, real Chromium, separate Linux namespaces,
separate profiles, and the private CDP bridge. The fixture browser disables its
inner Chromium sandbox because this host’s AppArmor policy prohibits nested user
namespaces; the outer filesystem, process, and network isolation remains enabled.
**Production never uses that exception.** Production Chromium sandbox acceptance
and real Paycom acceptance require the later authorized host/connection setup.

See [DEVELOPMENT.md](DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md),
[security](docs/SECURITY.md), and [RELEASES.md](RELEASES.md).
