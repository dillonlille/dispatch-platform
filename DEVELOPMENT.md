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
