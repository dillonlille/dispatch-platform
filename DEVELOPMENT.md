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

## Adding a page

1. Write the page as one component file in `dashboard/src/` (a `features/` folder per
   product area arrives in a follow-up).
2. Add one entry to the table in `dashboard/src/app/routes.tsx`: `id` (its address),
   `scope` (`dsp` for `#dsp/<id>/<page>`, `platform` for `#<page>`), `label`, `icon`,
   `nav`, and `render`, which receives the session, the DSP view and `reopen`.
3. Access goes in the entry's `permission`, written once: the sidebar, the page and
   the "not available for your role" message all follow it.
4. A page without its own sidebar item names the item to highlight in `parent`.
5. Link with `dspHash`/`platformHash` and move with `navigate` from
   `dashboard/src/app/navigation.ts`; do not write hash strings by hand.
6. `tests/dashboard-structure.test.ts` fails on a duplicate id or an unknown parent.

## Adding a UI component

- Generic building blocks live in `dashboard/src/ui/`, one per file, exported from
  `ui/index.ts`. They hold no product knowledge: no API calls, no permission checks,
  no contracts, nothing about timecards or DSPs. The structure test enforces the imports.
- A component that knows the product stays next to the page that uses it.
- Before writing markup, look for the primitive: `Header`, `Tabs`, `Modal`,
  `ConfirmDialog`, `Popover`, `DataState`, `SearchInput`, `Pagination`, `SortHeader`,
  `DetailList`, `Badge`, `Empty`, `ErrorBox`, `Loading`, `useFocusTrap`.
- Loading and errors use `DataState`: no data shows the spinner, data shows the content.
- Mutations use `useAction` from `dashboard/src/lib/useAction.ts` for `run`, `busy` and
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
mail state per test. Specialized mail tests own their fixtures too. Use
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
