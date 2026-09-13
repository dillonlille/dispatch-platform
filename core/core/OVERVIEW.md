# Dispatch Core

Core owns platform administration, shared login, DSP membership, provisioning,
removal, and Core-first release rollouts. The shared dashboard lives in
`dashboard/`.

DSP services and provider implementations live in `runtime/`. Core sends
validated messages over the authenticated runtime-agent connection instead of
loading those implementations. The `shared/` package owns the messages,
transport helpers and runtime layout agreement. Both release artifacts carry
their own copy; neither application reads the other application's source tree.

`compatibility/` contains opt-in tools for the older same-user runtime setup.
Those tools are excluded from the Core and DSP release artifacts.

Run `./tooling/verify` from the repository root for source, behavior and package
boundary checks. Run `./runtime/tooling/verify` for the native package and live
two-account fixture. See [native DSPs](installations/NATIVE-DSPS.md) and
[backup and recovery](installations/RECOVERY.md).
