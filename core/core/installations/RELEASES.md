> Historical native/OCI recovery reference. The monolithic release commands below
> are retired. Follow the repository root RELEASES.md for current development.

# Automated release delivery

A user-requested release and its chosen version authorize publication followed by an agent-operated rollout. Updates is a read-only changelog viewer; the platform owner does not need to start installation there. Publication and server preparation still precede rollout, preserving the existing verification gates.

## Publish

All Dispatch changelog copy and revisions must be authored by a **Luna subagent at
Max reasoning** (`model: "gpt-5.6-luna"`, `reasoning_effort: "max"`,
`fork_turns: "none"`). This applies everywhere: GitHub summaries and entries,
platform Updates, dashboard popups, and changelog examples or previews. Supply
verified release changes and the current authoring schema; label synthetic examples
as fictional. The coordinating agent verifies facts and structure and returns prose
corrections to Luna. If Luna Max is unavailable, report that limitation instead of
substituting another author.

After the user selects a version, run `.github/workflows/release.yml` on `main` with `version` and a `changelog` JSON array. Each change has `kind` (`added`, `improved`, `fixed`, `removed`, or `changed`), `title`, and `description`. Pass inputs through a JSON file/stdin when using `gh workflow run`; do not interpolate changelog text into shell code.

The workflow verifies the selected commit, builds the native DSP package with its runtime dependencies, verifies two isolated service accounts, and builds portable Core/bridge bundles. It uploads the packages, `dispatch-release.json`, and checksums into a draft, checks GitHub's asset digests, then publishes. It never replaces a published version. Failed uploads leave a draft; a retry can resume only a matching draft and matching asset bytes.

Core bundles contain application files and the helper manifest. Packaging builds the dashboard JavaScript and CSS from the selected Git commit in disposable storage using the committed npm lockfile; it requires npm on the build machine and never uses ignored checkout bundles. Retained verified components already include those assets, so publication can reuse them without rebuilding. Installed hosts need no frontend build tools. They contain no host paths, service credentials, databases or deployment configuration. The host renders its own units and deployment manifest after verifying the published package.

## One-time host setup

Use the clean merged checkout to create a portable bootstrap bundle outside the repository:

```sh
./core/installations/bin/dispatch-release-build --core-only /tmp/dispatch-bootstrap-core.json
```

Create a private JSON file with the existing platform service's `uid`, `gid`, `localRoot`, `unitRoot`, `publicOrigin` (`https://dispatch.example.test`) and `port`. Existing private catalogs must be at `<localRoot>/config/oci-releases.json` and `platform-releases.json`, matching the platform's provisioning environment. The local and unit directories must belong to that service account.

Create a repository-scoped GitHub credential with read-only Contents access to `example-organization/dispatch-platform`. Supply it through protected stdin, never a command argument:

```sh
sudo ./core/installations/bin/dispatch-release-delivery-install /path/to/private-host-config.json /tmp/dispatch-bootstrap-core.json < /path/to/private-token-file
```

This installs sealed watcher code separately from Core, root-only configuration/token files under `/etc/dispatch/`, durable state under `/var/lib/dispatch-release-delivery/`, and a system timer. The token stays on the server and is never forwarded to asset redirect hosts or DSPs. Re-running the bootstrap with the same verified bundle can update the token/configuration; newer watcher code is installed at a new immutable commit path.

The root watcher downloads only from the fixed private repository and GitHub's release-asset hosts. It checks asset hashes, the published tag's commit and its ancestry on main, bundle paths, file manifests and matching runtime identity. It installs only immutable release directories and the verified release's argument-free host-switch permission. Catalog/status writes run as the platform service account. Neither the watcher nor the bootstrap changes active Core/helper pointers or creates rollout records.

## Recovery and status

The timer checks approximately every 45 seconds. Finished downloads survive retries; incomplete downloads resume when the server honors validated byte ranges. Preparation and catalog registration are idempotent across interruption. A release appears in the catalog only after preparation succeeds. Published identities and prepared directories are never overwritten. Preparation failures use bounded exponential backoff. The release operator investigates failures before retrying.

The release status adapter reads the credential-free `release-delivery-status.json`. The retained operator API can write a bounded retry request after platform-owner authorization; the changelog viewer does not expose this control. Internal errors and download URLs stay out of the UI. Root daemon logs contain closed error codes. Inspect `journalctl -u dispatch-release-watch.service` and the root-only state file when intervention is needed.

Legacy releases without `dispatch-release.json` remain usable in existing catalogs but are not automatically imported. The automation applies to releases published by the new workflow. The independently pinned Core updater remains in place throughout discovery, preparation and rollout.

## Local retention

After Core promotion, discovery and the independent updater use the current Core artifact. Completed native fleet rollouts remove obsolete local release directories after root verification and process checks. GitHub publication history and Cloudflare recovery archives remain remote. The download worker removes superseded download staging directories. See [native DSPs](NATIVE-DSPS.md) and [recovery](RECOVERY.md).

## Grouped release notes and history

The `changelog` workflow input also accepts a rich object. Read this section before
preparing grouped notes. Legacy arrays remain supported and render under “What’s new”.

```json
{
  "groups": [{"id":"backups","title":"Backups & recovery","icon":"database"}],
  "changelog": [{
    "kind":"added",
    "title":"Independent backups",
    "description":"Back up Core and DSPs separately.",
    "group":"backups",
    "icon":"copy",
    "details":"Optional longer explanation, shown when View details is expanded."
  }],
  "afterUpdating": [{"title":"Backup schedules","description":"Enable the backup schedules you want to run."}]
}
```

These are illustrative entries, not instructions applicable to every release. Write
short, factual descriptions and include after-update actions only when the release
requires them. Each action description must make sense on its own. An empty `details`
string omits expanded text; an empty `afterUpdating` list omits the notice. Group order
and entry order are authored; group and category counts are always calculated.

Groups have unique lowercase slug IDs (up to 40 characters), titles up to 80 characters,
and at least one change. Up to 20 groups and 100 changes are supported. Change titles
are limited to 160 characters, descriptions to 600, and details to 4,000 (plain text,
with newlines allowed). Up to 10 after-update actions may contain a 160-character title
and 600-character description. The presentation plus its plain-changelog compatibility
copy must fit within 254 KiB, leaving room for metadata in preparation-status receipts.
Approved icon identifiers are `database`, `users`, `user-plus`, `copy`, `calendar-clock`,
`chart-column`, `shield`, `check-circle`, `trash`, `lock`, `send`, `refresh-cw`, `plus`,
`pencil`, `trending-up`, and `info`. No remote icons, HTML, or executable content are used.

The builder derives the original `{kind,title,description}` array from these entries
and leaves the version-1 `dispatch-release.json` contract unchanged. It also produces
`dispatch-release-notes.json` with schema version 1, the release ID, source commit,
and rich notes. GitHub's release body is generated from the same input, including
expanded explanations and after-update instructions. Both attachment digests are
verified during publication. Editing the GitHub body alone does not change the UI.

### GitHub release notes

**Only the GitHub release body** uses the approved inline-attribution design (A):
a short summary, then **New**, **Improved**, **Fixed**, **Removed**, and
**Maintenance**, omitting empty sections.
`added` appears under New; `changed` and `improved` share Improved. Each compact
bullet starts with the change title in bold, then an em dash and concise description.
Finish the same paragraph with `by @author · PR #number`, linking the author profile
and PR separately. For changes spanning multiple PRs, pair each PR with its own
author. Attribution stays visible outside any Details disclosure. The release
page supplies the version heading; the generated body does not repeat it. Extended
explanations stay in per-entry Details disclosures. Actual after-update instructions
appear before the change sections.
There is no separate Highlights section. A Full changelog comparison link closes
the body when a previous release exists.

Rich authoring accepts optional GitHub-only fields:

- Top-level `github`: optional `summary` (nonempty plain text, up to 600 characters)
  and `previousTag` (the verified previous GitHub release tag, up to 160 characters).
  Supply a summary for new releases and omit `previousTag` for the first release.
- Per-entry `github`: `pullRequests` accepts up to 20 distinct PR references from
  `example-organization/dispatch-platform`, each shaped as `{"number": 55, "author": "example-organization"}`.
  `number` is a positive integer; `author` is the verified PR author's GitHub login
  without `@` (bot logins ending in `[bot]` are supported). Older integer-only
  references still produce labeled PR links without inventing an author. New
  release authoring must supply the object form for each associated PR.
  `maintenance` is an optional boolean.
  Set `maintenance: true` only for internal maintenance, refactoring, build, or
  test changes; this changes its GitHub section without changing its shared `kind`.

Luna Max authors the summary, entry copy, and classifications from the verified
changes. The coordinating agent retrieves each associated merged PR's number and
`author.login` from GitHub and verifies the previous tag before passing metadata to
Luna. Use the PR author, not the release publisher or merge operator. Include all
associated PR references on new entries; omit unavailable references instead of
guessing them. Changes without an associated PR remain readable without attribution.
The renderer creates the PR and comparison URLs and escapes plain-text copy for
Markdown. The fictional fixture
[`examples/github-changelog.json`](examples/github-changelog.json) demonstrates
this input alongside audience classification and concise popup overrides.

The builder consumes `github` fields only when writing `CHANGELOG.md`, which is
passed to GitHub's release body. It strips them before creating the unchanged v1
installation manifest, rich Updates sidecar, or popup data. The Updates page keeps
its feature groups, icons, counts, and expanded details; the dashboard popup keeps
its existing concise, audience-filtered sections. Old input without GitHub metadata
remains supported. Published releases and historical notes are not rewritten.

### Dashboard update popup

For releases that should announce changes on dashboard entry, add `audience` to
**every** rich changelog entry and after-update action. Use `platform` for changes
exclusive to platform administration, or `dsp` for changes relevant to DSPs and their
dashboards. Platform owners see both; DSP owners see only `dsp` entries. Classify
shared changes as `dsp`. Audience labels are never displayed in the popup.

Each changelog entry can also include `popup: {"title":"Short title","description":"Concise explanation."}`.
This overrides only its popup copy; the existing title, description and details remain
in the GitHub release and platform Updates page. Without an override, the popup uses
the original title and description. Required after-update actions use the same copy
across surfaces and must have an explicit audience. The synthetic example is
[`dashboard/examples/popup-changelog.json`](../../dashboard/examples/popup-changelog.json).

The builder strips these authoring-only fields from the existing v1 notes attachment
and installation manifest. It embeds the curated copy in
`code/dashboard/release-popup.json` within the checksummed Core bundle,
with the release ID, version and source commit. Existing watchers can therefore
prepare the release unchanged. The file is private to the server and is not a static
web asset. Legacy authoring without audience fields remains valid and produces no
popup; missing classification must never expose legacy platform notes to a DSP.

`GET /api/updates/popup` returns only the authenticated owner's visible changelog for
the running Core release, after its platform rollout has completed and Core verification
has succeeded. A DSP owner also needs an active DSP with a ready installation on that
release. Staff and platform-owner DSP viewing sessions receive no popup. A DSP with no
relevant entries receives none. The API removes audience and source metadata.

The centered dialog shows New, Improved (including Changed), Fixed, and Removed
sections as needed, plus actual after-update actions. It checks once on dashboard
entry and does not interrupt navigation with newly discovered updates. Got it, X and
Escape all use the same authenticated, CSRF-protected POST with `{ "releaseId": "..." }`.
Dismissals are idempotent records in `release_popup_dismissals`, keyed by user and
release, surviving new sessions and devices. The dialog closes after persistence
succeeds; a failed save leaves a retry action. Background clicks do not dismiss it.
Only the current release is announced, so returning users do not receive a backlog
of dialogs. Existing platform Updates history remains unchanged.

### Compatibility transition

Older watchers ignore the optional notes attachment and prepare the unchanged v1
manifest normally. Older dashboards continue reading their unchanged installation
catalog. The new dashboard renders legacy notes without requiring rich metadata.
During a release-driven rollout, Core promotion updates the independently supervised
watcher to the new Core artifact (see `core-systemd-deployment.js`). On its next tick,
the new watcher imports the rich attachment even if the older watcher already marked
that release ready; it does not download the runtime again. Installing the new watcher
with the bootstrap above also enables this capability before Core promotion. No extra
release, version choice, or rollout is implicit in this transition.

The notes attachment must match the manifest's release ID, commit, and complete ordered
legacy changelog. Its GitHub digest is checked and pinned. Later changes or removal
are rejected once observed. Verified notes are stored as private per-release files in
`<localRoot>/config/release-notes/`, keeping extra fields out of legacy catalogs.

### Past changelogs

The Updates release selector offers published release history, marks the installed
release, and allows reading past notes without offering a rollback. Installed notes
remain visible after completion. Rollout is operated through the local command below;
only the newest available release can start a new rollout.

The watcher snapshots local catalog metadata to `<localRoot>/config/release-history/`.
After current-release preparation it also backfills GitHub releases that have verified
v1 manifests: at most five per timer tick, downloading only manifests and optional notes.
It checks digests, tag/commit identity, and ancestry on main, pins accepted fingerprints,
and retries failures with bounded backoff. History failures do not hide the current
update. Releases published before structured manifests can be shown if a local catalog
or rollout snapshot still contains their notes; missing legacy text is not invented.

These small metadata records survive installation-package retention. The API returns
history summaries plus the selected release's notes through
`GET /api/platform/updates?releaseId=<id>`, under the same platform-owner authorization.
Invalid or unknown IDs fail; historical metadata never populates installation catalogs.
Missing or unreadable rich notes fall back to the verified plain changelog.

## Efficient update coordination and recovery artifacts

Updates still require verified backups, verify Core first, and upgrade DSPs one
at a time. Scoped Core and DSP exports consume sealed snapshots without stopping
the dashboard, reconciliation worker, or DSP services. Legacy whole-host capture
retains its writer freeze and active-job guards.

Queue creation wakes the independent user service after the outer database
transaction commits. Productive reconciliation passes drain immediately; waits
and healthy pending work exit successfully. A fixed `backup-ready` notification
file wakes the root exporter through a systemd path unit. One-minute fallback
timers recover missed notifications. The separate updater survives Core restarts.

Immutable installed release trees are captured into shared, encrypted Restic
repositories at `recovery-artifacts/<manifest-sha256>`. A per-release file lock
serializes first capture, and a full readback verifies each new shared artifact
before publishing references. Subsequent archives contain the authenticated file
inventory and exact artifact snapshot references instead of the runtime bytes.
Recovery hydrates and verifies those references before ordinary capsule
validation and restore. Missing or altered artifacts stop recovery before install.
The local cache is disposable; backup deletion and local release cleanup never
remove the remote shared artifacts. Their separate indefinite R2 lock deliberately
retains even currently unreferenced release artifacts. Automatic remote artifact
garbage collection is not enabled. Storage totals include shared artifact bytes
once, separately from per-backup bytes.

Use a recovery kit exported from this implementation for backups using shared
artifacts; older kits cannot hydrate these references. New kits still restore
older self-contained backups. The full repository check verifies referenced
shared repositories as well as the individual backup repositories.

Lifecycle and Core stage start/end times, attempts, durations, safe failure codes,
and dependency waits are stored in `operation_stage_timings` in the private
access-control database. A running interval without an end records interruption;
a retry creates a new interval. Export receipts separately record snapshot-copy,
recovery-capture, repository-preparation and encrypted-upload timings. These are
operational diagnostics, not authentication or business payload logs.


## Release-driven rollout

After publication, the release operator runs the following **on the platform host as the Core service account**, using the confirmed live local root, user-selected version and verified release commit. The protected local command uses filesystem authority, records the existing active platform owner as the rollout actor, and creates no browser session. It prints only release identity and public rollout status, never login credentials or backup payloads.

```sh
./bin/dispatch-access-admin rollout-status --local-root /path/to/live/local --version VERSION --commit SOURCE_COMMIT
./bin/dispatch-access-admin rollout-start --local-root /path/to/live/local --version VERSION --commit SOURCE_COMMIT
```

Use the installed Core command, or the verified release checkout when upgrading from a version that predates this CLI. Do not use a development worktree's default database. Every command requires the exact version and 40-character commit. Status reports `not_prepared` until matching Core/DSP catalogs exist, `ready` before start, then the rollout's actual status and backup/Core/DSP progress. A conflicting commit is rejected. Wait for `ready` before starting; investigate preparation errors in the independently supervised release watcher.

Poll `rollout-status` until `completed`, verifying Core and every remaining DSP against the selected release. Start is idempotent for an existing target, including paused or completed rollouts. A different active rollout is rejected. Backups must verify before Core switches, Core must verify before DSP updates, and DSPs update sequentially through existing supervised workers. The command queues work; its successful exit alone does not mean installation completed.

If a rollout pauses, investigate the failed service or backup, resolve the cause, and then run `rollout-resume` with the same flags. `rollout-pause` is available to the operator with the same target guard. Neither status polling nor repeated start resumes failed work. Preserve the existing rollback, backup verification and recovery checks. Report completion only after verified rollout completion; otherwise report the concrete blocker.

The Updates page always exposes published release history and changelogs, including installed and older releases. Refresh, version search, release selection and expanded notes are read-only; operational controls remain outside this page.

## Split release packages (manifest v2)

The release builder accepts `--format legacy|split`. The publication workflow
exposes the same choice and defaults to `legacy` during migration. Legacy output
remains compatible with installed v1 watchers. Split output uploads exactly:

- `dispatch-release.json`: release identity, component hashes and expanded sizes,
  runtime compatibility, pinned dependency versions, and embedded structured notes.
- `dispatch-app.tar.gz`: Core/dashboard/helper files, bridge, and DSP application code.
- `dispatch-dependencies.tar.gz`: pinned Node/Chrome and the runtime libraries
  captured with Node. Dependency contents have no application commit or build timestamp.

The v2 runtime identity hashes the ordered application/dependency digest pair.
The assembled runtime retains its original full file inventory and installed
layout. Archive extraction rejects links, traversal, unexpected roots, missing
files, duplicate entries, oversized inventories and checksum mismatches. Expanded
sizes are checked against the authenticated inventories and used for disk preflight.

The watcher reads both manifest versions. It caches the latest verified dependency
archive by SHA-256 and reuses it across releases. Each GitHub release remains
self-contained: its dependency asset is uploaded and verified even when another
release has identical bytes. Installed releases and recovery backups contain full
runtime files and do not depend on the download cache. Successful preparation
removes superseded dependency downloads; it does not alter recovery retention.

Interrupted downloads resume against the same GitHub asset ID, size and digest.
A server that ignores byte ranges causes a clean restart. Every resumed file is
hashed in full before use. Completed packages survive preparation retries.

`runtime-dependencies.json` pins Node and Chrome. The publication workflow installs
that exact Node version and downloads Chrome for Testing from Google's versioned
archive, checking the committed archive SHA-256. Split builds reject version drift.
Shared-library changes still change the dependency digest and require a download.
`build-metrics.json` records local build duration and package sizes; it is not a
release attachment. Runtime preparation measurements live in the root-only
`/var/lib/dispatch-release-delivery/preparation-progress.json`, including stage
elapsed times, current download bytes, disk requirements and dependency reuse.

### Migration order

Deploy v2 reader support using a legacy-format package or rerun the verified
watcher bootstrap on each host. Confirm the installed watcher code supports both
manifest versions before selecting `split` for publication. Do not replace an
existing published manifest or remove its assets. Old releases and their sidecar
notes remain readable. Publication alone does not initiate an update.

### Unified operator entry point

Use `core/installations/bin/dispatch-install` from the trusted checkout or
verified installed Core code, as root. This command handles host release delivery;
DSP onboarding still uses the existing provisioning flow.

```sh
# Inspect prerequisites without changing the host.
sudo dispatch-install check --config /root/dispatch-host-config.json

# Configure release delivery for a new or existing host. Supply the existing
# bootstrap Core bundle built with --core-only; keep the token on protected stdin.
sudo dispatch-install setup --config /root/dispatch-host-config.json --core /root/dispatch-bootstrap-core.json < /root/github-token

# Prepare an exact release through the same engine used by automatic discovery.
sudo dispatch-install prepare --version VERSION --commit COMMIT

# Prepare, then start the existing backup-gated coordinator for that exact release.
sudo dispatch-install update --version VERSION --commit COMMIT

# Inspect preparation, rollout phase, DSP status and bounded operation timings.
sudo dispatch-install status --version VERSION --commit COMMIT
```

Setup requires the configured Linux service account and host prerequisites. It
creates missing service directories, empty catalogs and provisioning environment,
preserving existing files. Account creation, initial host-control authority, owner
setup, external origin routing and backup credentials remain explicit host setup
steps. Preparation installs verified artifacts and registers catalogs without
activating Core. Update requires the existing configured platform and active owner;
it uses the original Core-first, sequential-DSP coordinator, backup proofs and
recovery checkpoints. Repeating update never resumes a paused rollout. Use the
existing explicit rollout-resume command after diagnosis.

## Faster release preparation and supervised handoff

Prepare one immutable `.changelog/<change>.json` fragment in each PR, using the
rich authoring schema above (including audience and optional popup copy). Luna Max
authors these entries under the Dispatch workflow. CI validates the fragments and
requires a new fragment for PR changes; fragments already merged to main are not
edited. `examples/fictional-fragment.json` is an explicitly fictional example.
Internal changes use per-entry `github.maintenance`. Fragment files do not contain
release versions or previous tags. After-update instructions describe only actual
required user actions.

From a clean checkout, aggregate fragments added since the actual last release:

```sh
node tooling/release-notes.js collect PREVIOUS_TAG COMMIT > /tmp/dispatch-notes.json
```

Review the aggregate against every merged change since that tag. When adopting
fragments for the first time, include any older changes without fragments in an
explicit Luna-authored notes file; aggregation cannot recover unrecorded changes.
Conflicting group definitions fail validation. GitHub, Updates, and popup data
continue to derive from the same entries. Optional PR links must be verified.

After the user requests a release and selects its version, run this on the actual
host as the Core account, from the clean selected main checkout:

```sh
python3 tooling/release.py start --local-root /path/to/live/local --version VERSION --commit COMMIT --notes /tmp/dispatch-notes.json
python3 tooling/release.py status --local-root /path/to/live/local --version VERSION --commit COMMIT
```

Omitting `--notes` aggregates fragments since GitHub's latest published release.
Preflight checks the selected commit's main ancestry, existing tags/releases,
changelog schema, live database readiness, configured Turnstile secret permissions,
free space, and updater supervision. No provider secrets enter workflow inputs,
logs, or the service definition. This is configuration validation, not a claim that
a real user completed an external provider's browser challenge.

The command saves one private request and a copy of its worker under
`LOCAL_ROOT/releases/`, then enables a separate user systemd service. The worker
survives terminal disconnects, Core restarts, and user-manager restarts. Existing
host configuration must keep the Core user's systemd manager running at boot.
`status` reports publication, server preparation, rollout progress, and completion.
The original explicit version and commit remain fixed throughout the operation.

Publication accepts successful verification only from the exact commit's newest
main push run, with all three existing jobs successful. If that run is still
active, selection waits up to five minutes for it before choosing fallback
verification. Its retained artifact must
have an unexpired matching identity and a verified GitHub archive digest. Otherwise
the release workflow invokes all three verification jobs, including browser checks.
Artifacts are retained for seven days. The builder validates component hashes and
commit identities again, reuses Core/bridge/runtime components, and generates fresh
release metadata and popup copy for the selected version. The host independently
verifies the published tag, manifests and downloaded artifacts before installation.

Publication signals the fixed release watcher path, with its timer retained as a
fallback. Once the catalogs match, the worker starts the existing backup-gated
rollout, verifies Core first, then each DSP sequentially. A completed workflow is
not a completed rollout. Completion requires all backups and all remaining services
to verify the target, followed by a successful check of the public authentication
session endpoint. The Updates page remains read-only.

A failed publication or paused rollout stops for diagnosis. After resolving the
cause, use `tooling/release.py resume` with the same identity flags. The command
does not rerun failed publication workflows; inspect and recover the original run
first. An uncertain workflow dispatch is reconciled by its unique request ID and
never blindly sent again. `rollout-status` uses a deferred read-only transaction,
so observation does not compete with rollout workers for SQLite's writer lock.

The root `dispatch-recovery-prewarm.service` prepares immutable release recovery
payloads after release staging and periodically in the background. It retains the
existing encrypted upload and readback proof before caching a shared dependency.
It does not substitute for fresh data/configuration/secret snapshots. Its per-root
locks coordinate with backups, and a maintenance lock prevents cache pruning
while preparation runs. Failure leaves ordinary backup verification mandatory.

Backup exports refresh their eligible queue while other uploads run, up to the
existing limit of three workers. New snapshots can use idle slots immediately;
removal and deletion intent is checked again before export. Active uploads drain
before releasing the parent deletion lock, including when discovery fails.


CI retains separate, digest-checked legacy and split component archives from the
same verified commit. Publication selects the requested format and rebuilds only
release-specific metadata and popup copy; split assembly preserves the dependency
archive bytes. Local build metrics are excluded from retained component archives.
The supervised release command accepts `--format split` on `start` after the
reader-first migration; omission keeps `legacy`. The selected format is persisted
with the request and checked again against the published asset set.

## Reproducible verification builds

The versioned `release-formats.json` defines native legacy and split asset names,
manifest schema versions, sidecar rules, and CI artifact suffixes. JavaScript
validation/build/publication and Python CI/publication checks share that contract.
Detached release workers snapshot their publication requirements in the immutable
request so they do not depend on a later checkout change.

For CI, `dispatch-release-build VERSION NOTES /absolute/new/output --format both`
creates `legacy/` and `split/` from one Core/bridge build and one native dependency
stage. Each format still has its own manifests, checksums, inventory validation,
and retained-component reuse checks. `both` is a verification build option;
publication still selects `legacy` or `split`, with the existing reader-first
migration requirement. No runtime deployment or backup checks are skipped.

Choose an output parent on a disk with room for expanded dependencies and both
archives; avoid a small tmpfs such as `/tmp`. The builder estimates space on that
filesystem, keeps its staging directories there, refuses existing output, and
removes its own output on handled build failures. Disk-full, archive timeout and
child interruption have distinct error codes. Disk estimates cannot reserve
space against unrelated processes, and abrupt host termination can leave scratch;
inspect and remove only the failed operation's directory before retrying.

CI stages only the contract's component files before uploading; build metrics and
scratch are excluded. Artifact downloads verify GitHub's digest before bounded
extraction and clean partial extraction after failures or interruption. See
`DEVELOPMENT.md` at the repository root for pinned local tooling and compact PR/CI
commands.

## Release readiness and recovery diagnostics

Run `python3 tooling/release.py check --local-root /path/to/live/local` during
preparation, before choosing or publishing a version. It runs GitHub access and
host checks in a fresh user-systemd service using resolved absolute executable
paths. `start` repeats this check and stores the paths in its private immutable
request; the detached worker therefore does not depend on an interactive PATH.
The check does not publish a release or start a rollout.

On hosts with the readiness service installed, the check signals an independent
root metadata scan and waits up to 45 seconds for a fresh, host-bound receipt.
Every intended native DSP must be present. The scan checks ownership, directory
and file permissions, unsupported links/files, backup size limits and free space
without reading payload contents or stopping services. Live changes or browser
artifacts can require waiting for a DSP to settle and checking again. The scan
never replaces the stopped-service snapshot or encrypted restore verification.
Older installed releases report `installed_release_predates_backup_readiness`;
their ordinary backup gates remain mandatory. A supported scanner that is missing,
stale or reports a problem stops publication. The independent readiness timer and
path service are installed by verified backup enablement alongside the existing
backup services; they continue working while exports are busy.

The same preparation signal starts background recovery prewarming for immutable
release files. Root-owned readiness and prewarming receipts contain bounded codes,
counts and timings, without credentials or private file contents. Prewarming keeps
its existing locks, encrypted upload and readback proof. Fresh data, configuration
and secret snapshots are still captured for each rollout. No elapsed-time reduction
is assumed until measured on subsequent releases.

Use `tooling/release.py status` with the existing identity flags and `--compact`
for a concise view of the release phase, backup members, Core and DSP progress.
The ordinary status also retains operation-stage timings. Phase history records
execution, attention and resumed intervals separately across worker restarts.

Command failures are persisted as safe codes with their failed phase. Deterministic
failures stop for diagnosis instead of restarting indefinitely. After resolving the
cause, use the same `resume` command and release identity. A failure to execute the
initial GitHub CLI proves that no dispatch was sent and allows explicit retry;
network failures and other uncertain dispatch outcomes resume workflow observation
without another publication request. Recovery writes are serialized with the worker.
Published assets, verification gates and the Core-first sequential rollout remain
unchanged.

Inactive browser cleanup additionally restricts only the recognized `.cache` and
`.cache/fontconfig` directories from 0755 to 0700. It retains cache contents and
rejects active profiles, symlinked directories, foreign ownership and unexpected
permissions. Existing stale PulseAudio runtime-link cleanup continues to apply.
