# Dispatch Core

Shared services and dashboard for Dispatch. This project owns the complete web
application, platform-owner features, API, SDK source, authentication/browser
coordination, host management and update coordination.

DSP runtime and plugin source belong to the separate `dispatch-dsp` project.
Each product builds independently, with explicit versioned dependency packages.
Every DSP retains its own installed code and private state.

- [Directory map](AGENTS.md)
- [Local development](DEVELOPMENT.md)
- [PR and release workflow](RELEASES.md)
- [Independent update operations](core/updates/README.md)
- [Architecture and storage](docs/architecture.md)
- [Security policy](SECURITY.md)

Core and DSP use separate public repositories and release versions. Publishing a
GitHub release makes it available; installing it is a separate owner action. See
the update operations guide for initial deployment and recovery prerequisites.
