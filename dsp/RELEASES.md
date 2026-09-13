# Repository and release workflow

Core and DSP are separate repositories, release versions and installation tracks.
The SDK is developed in Core but distributed as a versioned dependency artifact.
Updating Core never rewrites an installed DSP's runtime, plugins or SDK copies.

1. Create a feature branch and develop there.
2. Run applicable checks and open a PR against `main`.
3. Present the PR URL, changes, verified commit and test results in chat.
4. Wait for the user's explicit chat approval before merging that PR. Recheck the
   approved commit and required checks immediately before merging.
5. Only when the user says **prepare a release**, inspect the latest merged main,
   report the currently published and deployed versions for the selected product,
   and ask for the next version number. Do not choose it automatically.
6. Build and verify immutable artifacts from that main commit, collect a readable
   changelog, and publish the selected product's release. Publishing does not install.

The future owner Updates area has independent Core and DSP pages. Core shows its
changelog and an Update Core action. Shared dashboard/API features should first be
validated in a separate Core preview connected only to the permanent Dev DSP.

For DSP releases, Update Dev installs only the permanent testing DSP. Successful
installation and health checks enable Rollout Update. A newer release before
rollout resets the required Dev test. Rollout processes DSPs one at a time, checks
each DSP and pauses on failure. A rollout already started stays pinned to its exact
artifact even if another release is published. Retain previous code and a compatible
state snapshot for rollback; reverting code alone cannot undo a database migration.

Core owns the local foundations in `core/updates/local-releases.js`,
`host/releases/runtime.js` and the package catalog's per-DSP approvals. These are
internal lifecycle ports, not public HTTP installation endpoints. Activation hooks
must drain processes, snapshot private state, start selected code, verify health
and restore on failure. Recover interrupted operations explicitly before continuing.
The persistent state directory is private and is never included in source exports.

The GitHub feed, permanent Dev DSP deployment, separate Core preview, privileged
activation hooks and owner Updates UI are subsequent work. The development builder
still produces development candidates. Publication uses the separate guarded
workflow below; no release version or production baseline is assigned by setup.

Core's legacy `core/installations/RELEASES.md` documents old native/OCI recovery formats.
It does not authorize or describe the new release workflow.

## GitHub publication

`.github/workflows/release.yml` accepts only a manual dispatch from `main`, the
owner-selected `version`, the verified 40-character `expected_main` commit, and
reviewed `changelog` text. Dispatch it only after the owner requests a release and
supplies its version. Pass inputs as structured JSON; do not interpolate notes
into shell commands. The release worker checks that main still matches and has a
successful main-push checks run. It checks again before publishing.

The SDK's `tooling/release-publication.js` packages a fresh verified development
build, records the source repository/commit and selected version, includes the
notes in its hashed inventory, and produces a deterministic tar archive plus
`release.json`, `release-notes.md` and `SHA256SUMS`. Core also publishes
`platform-packages.tar.gz`, bound by digest in the release manifest. Each asset
receives GitHub build provenance. Publishing verifies the signer workflow, main
source ref, source commit and hosted runner before creating the version tag and
a draft release. It downloads and compares the uploaded assets before publishing.

Existing tags or releases, including drafts, are never overwritten. A failed
publication can leave a reserved tag or draft; inspect it and its verified assets
before recovery. Do not repeatedly dispatch publication or delete history to make
CI pass. Reusing a published SDK/support-package/plugin version with different
installed bytes is rejected; bump that component in a reviewed PR first.

The release job has GitHub publication permissions only. There are no production
SSH credentials, service restarts, deployment hooks or DSP activation steps.
GitHub publication and installed-version verification are separate operations.
The first real publication is still pending an owner-selected version; do not
claim that upload/attestation publication has been exercised by the unit tests.

## Core dependency bootstrap

`tooling/platform-dependencies.json` is a reviewed dependency lock. Development CI
may use `developmentSource` with a full Core commit. A separate job builds that
commit's package bundle; the DSP job receives only the bundle and verifies its
checksum. Every run creates a fresh artifact, so development does not depend on an
expiring artifact from an earlier run. This never activates or publishes a product.

Production publication rejects the development source mode. After the first Core
release, pin that release's `platform-packages.tar.gz` URL and SHA-256 in a DSP PR.
`tooling/fetch-platform.py` verifies the downloaded archive before extraction.
Future SDK upgrades change the lock and declared package versions together.
