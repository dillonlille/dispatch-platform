# Dispatch DSP

This is the `dispatch-dsp` repository. Develop in feature worktrees,
open PRs, and present verified PR details before requesting merge approval.
Merge only with explicit approval in chat. Publishing requires a user-requested
release and user-selected version. Installation is a separate owner action.
In the Dispatch workspace, also read the workspace `AGENTS.md` and `dev/AGENTS.md`.

- `runtime/`: DSP supervisor, jobs, collector execution, scoped workers and local vault/session handling.
- `plugins/`: Paycom and future plugin source, including each plugin's frontend.
- `tooling/`: portable checks/builds and frontend compiler dependencies.
- `bin/`: DSP command entry points.
- `compatibility/`: retained legacy adapters.

The SDK source belongs to Core. Bootstrap from its verified package bundle;
never import a sibling Core checkout. Each DSP release contains its own copies
of the SDK/protocol/runtime support packages and sealed plugin packages.
Credentials, settings, databases and installed code belong to each DSP's private
runtime directory, never this repository. See `DEVELOPMENT.md` and `RELEASES.md`.
