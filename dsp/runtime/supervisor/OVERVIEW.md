# DSP process supervision

This directory supervises the fixed built-in processes for one DSP: Auth Broker, Collection Manager, Runtime Gateway and Runtime Agent. A child failure stops the service, and systemd restarts it within bounded limits.

The current backend is `native_service_v1`: separate Linux accounts and private data, shared immutable code, private Chrome debugging pipes, and per-service resource limits. `native-host-fixture.js` exercises two real accounts and file recovery. OCI definitions and examples remain for compatibility with previously installed releases.

See [native DSP architecture and operations](../../core/installations/NATIVE-DSPS.md).
