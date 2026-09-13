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

The owner Updates area has independent **Core** and **DSPs** tabs, release
history and changelogs. **Update Core** changes the shared dashboard, API and
services; it leaves installed DSP runtimes, plugins and SDK copies in place.
Validate shared changes in an isolated Core preview before installing them.
There is no automatic Core preview or automatic production deployment.

**Update Dev** installs the latest DSP release only on the configured permanent
Dev DSP. A successful installation and live health check enable **Rollout Update**.
The owner tests Dev and chooses when to start rollout. A newer published release
before rollout requires another Dev update. An active rollout stays pinned to its
selected artifact, updates one DSP at a time and pauses on failure. A completed
rollout sets the default version for new DSPs; a Dev candidate never becomes that
default. DSPs created during a rollout join its remaining queue.

Each DSP release still includes runtime code and all catalog plugin packages.
Core caches the full verified release, then copies only runtime code and catalog
metadata into each DSP. Optional plugin code is copied on Install and upgraded
only for DSPs where that plugin is installed (enabled or disabled). Later installs
use the plugin version approved by the DSP's selected release. Fresh DSPs expose
only the built-in Cortex connection. Existing full runtime copies are retained
for compatibility and rollback; new release copies omit plugin payloads.

Updates require a verified initial split deployment, a permanent Dev DSP and the
separate update worker. The first published `0.0.1` Core predates these controls;
it cannot install this feature by itself. See [update operations](core/updates/README.md)
for configuration, adoption prerequisites, lifecycle/recovery and test commands.
The updater never treats a source checkout or development build as a published
release. Publishing and installation remain separate owner decisions.

Legacy `core/installations/RELEASES.md` documents old native/OCI recovery formats.
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
Core and DSP `0.0.1` have been published and their GitHub assets and attestations
verified. That publication did not install them on the platform.
