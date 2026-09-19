# Development workflow

Develop on dispatch-dev in an isolated worktree created from `origin/dev`.
Keep `/home/thepickle/dispatch-platform/dev` clean; its updater owns the live runtime.
Development PRs target `dev`. Merge only when the owner explicitly requests it.

## Validation

During implementation, run focused checks for the changed behavior. Before pushing,
review the diff, run `npm run check` for TypeScript changes and the relevant tests:

- Python tooling: `python3 -m unittest discover -s tests -p '*_test.py'`.
- Browser behavior or its fixtures: `npm run build` then `npm run test:ui`.
  Pass a file or `--grep` after `--` to focus on a flow while iterating.
- Rust changes: the affected Cargo tests and formatting/lint checks.

Use `npm run pr:prepare` after committing. Push the finished change and create or
update its PR once; review it while GitHub performs the complete required checks.
Do not repeat the full local CI suite just to duplicate a successful GitHub run.
Rerun affected checks after fixes, new changes, or failures. All required GitHub
checks must pass for the final PR head. Keep its branch and worktree until merged.

## Adding a test

- **API tests** drive the compiled binary: `tests/api-<area>.test.ts` (auth, members,
  collection, workforce, operations, hardening) or `tests/<feature>.test.ts`. Helpers:
  `fixture()`, `until()` and `demo` from `tests/support.ts`, `capturedMail` from
  `tests/mail-support.ts`. One test:
  `python3 tooling/cargo-build.py && npx tsx --test --test-name-pattern 'password recovery' tests/api-auth.test.ts`
- **Dashboard logic tests** need no server: `tests/<name>.test.ts`, listed under
  `dashboard` in `tooling/test-plan.json`. One file: `npx tsx --test tests/dashboard-format.test.ts`
- **Browser specs**: `tests/browser/<flow>.spec.ts`. Helpers: `test`, `expect`, `login`,
  `signIn`, `openDsp` and `demo` from `tests/browser/fixtures.ts`. One test, after
  `npm run build`: `npm run test:ui -- roles.spec.ts --grep 'owner creates'`
- **Rust integration tests**: `backend/tests/<area>.rs` (storage, network_policy, workforce,
  jobs, audit, accounts and the HTTP, meal and egress files). Helpers: `store()`,
  `bootstrapped()`, `seeded()` and `audits()` from `backend/tests/common/mod.rs`. One test:
  `cargo test --locked --test jobs listed_jobs`
- **Python tooling tests**: `tests/<tool>_test.py`; `artifact()` from
  `tests/dev_updater_test.py` builds a runtime. One test:
  `python3 -m unittest discover -s tests -p 'release_test.py' -k prepared`

Shared pieces:

- `fixture()` lives in `tooling/fixture-server.ts` and is the only code that starts a
  private server: temporary state, a free port, the fixture environment, `seed` (or
  `bootstrap` with `seed: false`), `serve`, the health wait and `client()` to sign in.
  Pass `env` to change the environment. The smoke check and `npm run dev` start their
  servers through it; the benchmark takes its `prepare()` half and times its own start.
- A browser test asks for `dispatch` to reach its own server (`dispatch.root`,
  `dispatch.client()`, `dispatch.database()`); `page` already points at it. A spec that
  needs another environment sets `test.use({ dispatchOptions: { seed: false, env } })`,
  or overrides `dispatchOptions` in `test.extend` when the value comes from another
  fixture, as `mail-diagnostics.spec.ts` does. A spec that needs no server imports
  `test` from `@playwright/test`.
- A new `tests/*.test.ts` file runs in the core check. One that only exercises dashboard
  code belongs in the `dashboard` list of `tooling/test-plan.json`, so dashboard-only
  changes still run it; a native collector suite belongs in a `native` shard there.
  `tests/test-plan.test.ts` fails when a test file is run by no check or by two.
- Rust test files are separate crates; `mod common;` gives each the shared store. It is
  the one place that calls `Config::load()`, which reads the process environment.

## Adding an endpoint

1. Write the handler in `backend/src/http/routes/<area>.rs`. A database handler is
   `fn(&Store, &Member, &Input) -> Result<Reply>`; its second argument is what the
   route's access produced (`Anyone`, `User` for a session or platform owner, `Member`
   for a DSP permission). Path parameters come from `input.param("name")`.
2. Register it in that file's `routes()` with the access it requires:
   `read(path, access, handler)` for a GET, `write(path, access, handler)` for a POST.
   Access is `Public`, `Session`, `PlatformOwner` or `Dsp("permission")`. The helper
   authorizes and runs the handler inside one database closure. Add
   `.invalidates_schedules()` when the route changes which DSPs or schedules exist.
3. Work that must wait outside the database uses `async_get`/`async_post`. Its handler
   receives the registered access and calls `access.authorize(db, &input)` inside its
   own `state.read`/`state.run` closure, and `access.revalidate` after each wait.
4. Add the route's row to the inventory in `backend/tests/http_routes.rs`.
5. When the dashboard consumes the response, add its type to `shared/contracts`.

## Where things live

```
dashboard/src/
  main.tsx     entry point: session, DSP view, Shell and the open page
  app/         app-wide plumbing every feature may use: api, useAction, feedback, navigation,
               route-meta, routes, permissions, session, live updates, presence, Brand
  shell/       the frame around a page: sidebar, account menu, view-as-role banner
  ui/          generic building blocks with no product knowledge, one per file
  lib/         pure helpers: format, errors, backoff, activity
  features/    one folder per product area (auth, home, platform, timecard, team,
               connections, audit, settings), one component per file, `index.ts` as its entry
```

`tests/dashboard-structure.test.ts` holds the layout: `lib` imports nothing else, `ui` imports
`lib` only, features import `ui`, `lib` and `app`, a feature reaches another only through its
`index.ts` and only on an edge listed in the test, only `app/routes.tsx` and `main.tsx` import
features, and no modules import each other in a cycle.

## Adding a page

1. Write the page as a component file in its product area's folder,
   `dashboard/src/features/<area>/`, and export it from that folder's `index.ts`.
2. Declare its address in `dashboard/src/app/route-meta.ts`: `id`, `scope` (`dsp` for
   `#dsp/<id>/<page>`, `platform` for `#<page>`) and `label`. A page without its own
   sidebar item names the item to highlight in `parent`.
3. Give it its entry under the same id in `dashboard/src/app/routes.tsx`: `icon`, `nav`,
   and `render`, which receives the session, the DSP view and `reopen`. The compiler
   rejects an address without an entry.
4. Access goes in the entry's `permission`, written once: the sidebar, the page and
   the "not available for your role" message all follow it.
5. Link with `dspHash`/`platformHash` and move with `navigate` from
   `dashboard/src/app/navigation.ts`; do not write hash strings by hand.
6. `tests/dashboard-structure.test.ts` fails on a duplicate id or an unknown parent.

## Adding a UI component

- Generic building blocks live in `dashboard/src/ui/`, one per file, exported from
  `ui/index.ts`. They hold no product knowledge: no API calls, no permission checks,
  no contracts, nothing about timecards or DSPs. The structure test enforces the imports.
- A component that knows the product lives in its feature folder,
  `dashboard/src/features/<area>/`, one component per file. What two features share moves
  down: visuals to `ui/`, pure logic to `lib/`, product plumbing to `app/`.
- Before writing markup, look for the primitive: `Header`, `Tabs`, `Modal`,
  `ConfirmDialog`, `Popover`, `DataState`, `SearchInput`, `Pagination`, `SortHeader`,
  `DetailList`, `Badge`, `Empty`, `ErrorBox`, `Loading`, `useFocusTrap`.
- Loading and errors use `DataState`: no data shows the spinner, data shows the content.
- Mutations use `useAction` from `dashboard/src/app/useAction.ts` for `run`, `busy` and
  `error`. Failures show at the top of the page and `success` is toasted; pass `inline`
  to render `error` inside a form or dialog instead.
- Formatting (`time`, `duration`, `bytes`, `title`, names) comes from `dashboard/src/lib/format.ts`.

## Adding a table or column

Each database kind has one numbered migration list in `backend/src/db/schema/mod.rs`:
`platform` (accounts), `jobs`, `dsp` (a DSP's `dispatch.sqlite`), `paycom` and `cortex`.

1. Pick the kind and add `backend/src/db/schema/<kind>/NNNN_name.sql` with the next number.
2. Append `Migration { id: NNNN, name: "name", apply: Sql(include_str!("<kind>/NNNN_name.sql")) }`
   to that kind's list. Use `Code(function)` only when the step must look before it changes.
3. Additive only: new tables, new nullable or defaulted columns, new indexes. Never edit or
   renumber a migration that has shipped, and never change `PRAGMA user_version`.
4. Rewrite the schema snapshots in `backend/tests/schema` and commit them with the change:
   `DISPATCH_UPDATE_SCHEMA=1 cargo test --locked --lib db::migrations`.
5. Run the schema tests: `cargo test --locked --lib db::migrations`.

Startup, the operator commands and DSP provisioning apply what a database lacks, each
migration once, in one transaction. Requests never migrate. The previous release must
keep working on migrated data, so anything that is not additive follows the
[rollback rule in RELEASES.md](RELEASES.md#production).

## Adding a data provider

1. Driver: `backend/src/browsers/<name>/` with a `Driver` that implements the `Driver` trait
   of `browsers/driver.rs` (`request`, `collect`, `browser`). Tabs, window size, script
   calls, screenshots, assistance and the attempt record come from `page.rs` and `attempt.rs`.
   Declare the module in `browsers/mod.rs`.
2. Collector: `backend/src/collectors/<name>.rs` implementing `Collector`: id, job kind,
   database kind, seed, storage marker (`storage.<name>`), credential fields, browser files,
   network policy, driver, fixture data, progress message, `publish`, `collected_at`, and,
   when schedules run it, `schedule`/`scheduled`. The seed must insert its `connections` row.
3. Storage: a `Kind` with a migration list under `backend/src/db/schema/<name>/`, as in
   "Adding a table or column". Its baseline needs `storage_identity`, `connections`,
   `collection_live_runs` and `collection_live_items`, as the Cortex baseline has.
4. Registry: a `Provider` variant, its entry in `Provider::ALL` and its arm in
   `Provider::collector`, all in `collectors/mod.rs`. Storage, connections routes,
   credentials, revocation, the queue, the executor and fixture mode follow the registry.
5. Hosts: a `NetworkPolicy` variant and its allow-list in `browsers/egress.rs`. The lists stay
   there on purpose, next to the proxy that enforces them.
6. Job kind: `jobs.kind` has a `CHECK` naming the two kinds, and `collection_schedules.collection`
   one naming `paycom`, `meal_break` and `both`. Neither can be altered in place. A new kind
   needs a rebuilt table over two releases per the [rollback rule](RELEASES.md#production);
   until then a new provider cannot queue jobs. `both` and the `v::choice` list in
   `schedules.rs` mirror that `CHECK`.
7. Dashboard: the job kind union in `shared/contracts` and the labels in
   `dashboard/src/collection-history.ts`. New count fields in job metrics are a
   `job_metrics.rs` and contract change; without them a job reports no counts.
8. A route that starts its collection, following `http/routes/jobs.rs` and "Adding an endpoint".

Features written about one provider stay where they are: `workforce.rs`, `collection_checkpoint.rs`
and `tenants.rs` (Paycom), `meals.rs` (Cortex), `meal_sync.rs` and `meal_comparison.rs` (both).

## Faster builds and deployment

The workflow selects full checks for backend, tooling, dependencies and unknown
changes; dashboard-only changes retain UI, type, formatting and artifact checks.
Full nightly and release validation remain in place.

A successful same-repository PR targeting `dev` preserves both its validation
receipt and tested runtime. After a requested merge, CI verifies the exact base,
head, source tree, run attempt, artifact digest and inventory. It reuses the tested
application bytes, binds commit metadata and the inventory to the actual merge,
and runs a smoke check before publishing the Dev artifact. Missing/expired build
artifacts fall back to a normal build; missing or mismatched validation falls back
to the appropriate checks. A newer failed or pending run cannot reuse older success.

Release PRs targeting `main` are promoted the same way. Their receipt is bound to
`main` and must record the full suite; a release merge without it runs every check.

CI release binaries are cached by Rust inputs, compiler, build flags and runner
image. Only trusted `dev`/`main` runs save the cache; PRs restore exact keys. A
promoted PR binary can warm that cache only when its recorded input key matches
this runner. Missing, corrupt, unsupported or changed inputs compile normally.
Local worktrees continue sharing the existing private binary cache.

Browser checks use four workers with separate seeded servers, ports, databases and
mail state per test. Specialized mail tests configure the same fixture. Use
`npm run test:ui -- --workers=1` when comparing sequential timing. Screenshots and
traces use test-specific output paths. Build once before comparing runs.

The Dev timer still checks every ten seconds, waits for successful checks of the
current branch head, and verifies the installed runtime. Failed activation restores
the previous version. Measure PR checks, merge checks and actual deployment
separately; GitHub runner queue/startup time is outside the updater's control.

## Open browser updates

The served document includes its runtime identity. Signed-in pages check
`/api/browser-update` every five seconds and when returning to a visible tab.
The endpoint advertises readiness only after the updater records the matching
healthy runtime and removes its activation receipt. Production uses its existing
`production-update.json`; Dev records the installed digest in `dev-update.json`.
Local development/fixture servers do not require an updater receipt.

Once a different runtime is ready, the page reloads after two seconds without
pointer, keyboard, touch, input, or scroll activity. Hidden tabs wait until visible.
Open forms and dialogs conservatively defer refresh until closed or left, including
saved forms that remain on screen. In-flight API writes also defer refresh.
DSP/route, Timecard tab/date, supported table filters/sorting/pagination and window
scroll position survive the refresh. Only explicit navigation state is retained;
passwords, verification input and form drafts are never serialized. Failed checks
clear the pending update; a per-build five-minute guard prevents reload loops.
Storage-blocked browsers skip automatic refresh to preserve state and loop safety.
