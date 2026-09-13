# Dispatch Platform

Public repository: dillonlille/dispatch-platform. Keep credentials, DSP data and
host configuration outside source. Develop in isolated feature branches; PRs may
be created and merged autonomously after review and passing checks.

- core/: Platform Owner dashboard, shared API/services, host isolation, updater
  and SDK source. Existing internal service modules remain under core/core/.
- dsp/: DSP runtime and DSP-owned dashboard entry point/pages.
- plugins/: optional plugin source, including Paycom; released with DSP updates.
- shared/dashboard/: shared UI source compiled separately into each dashboard.
- tooling/: monorepo assembly, checks, publication and migration helpers.

Read DEVELOPMENT.md and RELEASES.md. Build/test in an external synthetic workspace.
SDK/support packages are real versioned copies. Dashboard assets are central per
release; each DSP selects its approved version and owns its installed plugins and
private state. Core builds must not contain DSP-owned dashboard pages.

One user-requested vX.Y.Z release contains Core/DSP packages and three changelog
sections. Ask for a version unless supplied. Publishing never installs. Update Core
and Update Dev → Rollout Update are independent owner-controlled installation paths.
