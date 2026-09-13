# Dispatch Core

This is the `dispatch-core` repository. Develop in feature worktrees,
open PRs, and present verified PR details before requesting merge approval.
Merge only with explicit approval in chat. Publishing requires a user-requested
release and user-selected version. Installation is a separate owner action.
In the Dispatch workspace, also read the workspace `AGENTS.md` and `dev/AGENTS.md`.

- `core/`: shared API, accounts, authorization, browser manager, auth broker,
  plugin service coordination and update state.
- `dashboard/`: the complete shared dashboard, including platform-owner pages.
- `sdk/`: source of the separately packaged Dispatch SDK and plugin authoring tools.
- `shared/`: versioned `dispatch-protocol` contracts and transport helpers.
- `packages/runtime-kit/`: shared queue/storage adapters used by Core and DSP.
- `host/`: isolated DSP storage, processes, networking, package installation and recovery.
- `tooling/`: local checks, builds, exports and repository workflow helpers.
- `tests/`: synthetic fixtures, integration and native isolation acceptance tests.
- `compatibility/`: retained legacy provisioning adapters; not the new release path.

Use `DEVELOPMENT.md` for commands and `RELEASES.md` for the approved workflow.
Production code must not import `dispatch-dsp` source. Shared dependencies are
real, versioned package copies. Keep private state, credentials, logs, dependencies
and generated development artifacts out of source exports. Use synthetic DSPs.
