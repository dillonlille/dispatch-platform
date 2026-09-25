# Dispatch

Dispatch combines a Rust backend, React dashboard, and an email delivery Worker.
Run commands from the repository root.

| Directory                                     | Owns                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `backend/ci/`                                 | Rust CI policy, build cache, PR preflight and shared process execution       |
| `backend/host/`                               | Rust artifacts, releases, host setup and Dev/Production management           |
| `backend/src/`                                | HTTP, accounts, workforce, meals, jobs, providers and storage                |
| `dashboard/src/features/`                     | Product screens, their styles and artwork                                    |
| `dashboard/src/app/`, `shell/`, `ui/`, `lib/` | App infrastructure, navigation frame, reusable controls and pure helpers     |
| `shared/contracts/`                           | API types and runtime validation; `generated/` comes from Rust               |
| `services/cloudflare-mail/`                   | Email Worker and its generated environment types                             |
| `tests/`                                      | API, dashboard, provider, tooling and browser checks; fixtures in `support/` |
| `tooling/`                                    | Build, CI, preview, test, benchmark and asset helpers                        |

Backend domain folders expose their entry points through `mod.rs`. Rust owns punch
interpretation and meal assessment; the dashboard formats typed assessment results. Dashboard features
expose theirs through `index.ts`. Styles live with their owner; `dashboard/src/styles.css`
sets the global import order. Shared contracts and tooling never import dashboard code.

Use an isolated worktree branched from `origin/main`, then `npm ci` and `npm run dev`.
The preview prints a private fixture URL. `npm run check:ci` runs full validation;
`npm run check:ci -- checks` runs the dashboard checks against a build. `npm test` discovers
TypeScript tests recursively; Python tooling tests use
`python3 -m unittest discover -s tests/tooling -p '*_test.py'`.

`npm run contracts:generate` updates the committed TypeScript bindings. Normal Rust
tests verify them without rewriting files. Generated types, schema snapshots and
approved artwork remain with their owners.

The Python entry points at the top of `tooling/` retain their installed/CI paths;
CI policy, build caching and PR preflight delegate to the small `dispatch-ci` executable.
Artifact verification and promotion, releases, fresh setup and updaters delegate to
the Rust host manager.
See [CI policy](tooling/ci/README.md) for validation and artifact reuse rules.
The [release command guide](tooling/RELEASES.md) covers preparation, publication and recovery.
See [the Dev host guide](tooling/DEV-HOST.md) for that layout. The development and
release guides remain outside Git at `/home/thepickle/dispatch-platform/docs/`,
routed by the `dispatch-development` skill.
