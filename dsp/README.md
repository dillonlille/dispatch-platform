# Dispatch DSP

The DSP runtime and installable plugins for Dispatch. Paycom is under
`plugins/paycom`; future plugins follow the same SDK contract and packaging flow.

The shared dashboard, platform-owner features, API and SDK source live in
`dispatch-core`. DSP builds consume versioned SDK/protocol/runtime support
packages and include their own copies. Each DSP installs and runs its own code,
with separate settings, credentials, databases and browser sessions.

- [Directory map](AGENTS.md)
- [Local development](DEVELOPMENT.md)
- [PR and release workflow](RELEASES.md)

Builds create development candidates. Publishing, updating the permanent Dev DSP
and rolling out to production DSPs are separate steps controlled by the owner.
