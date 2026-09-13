---
title: Runtime Agent source
status: current
last_verified: 2026-09-03
---

# Dispatch Runtime Agent

`core/agents/` contains the central hub and clients used to contact isolated DSP runtimes. The outbound DSP agent lives in `runtime/agent/`; shared wire definitions live in `shared/agent/`.

## Source map

- `src/hub.js` — central registration, runtime registry, heartbeat/liveness, request correlation, and failure cleanup.
- `src/client.js` — narrow `DispatchClient` adapter for a server-owned runtime identity.
- `src/control.js` — central private control socket.
- `../../runtime/agent/src/` — outbound agent, health socket, and supervised CLI composition.
- `../../shared/agent/` — registration frames, bounded JSON framing, and private credential loading.
- `examples/` and `tests/` — routing, reconnection, identity, and failure-isolation verification.

## Boundary

Core owns human authorization and runtime selection. Access Control stores only runtime registration digests and generations. Provisioner stores each raw token only in that runtime's private `secrets/runtime-agent/registration-token` file. The Agent owns one runtime's private operational connection and proxies only the closed Runtime Gateway action catalog.

Each production DSP runs in an isolated OCI container. Its outbound connection reaches the Core hub through the host bridge. The opt-in same-user runtime tools remain under `compatibility/`.

## Verification

```bash
./core/agents/scripts/verify
```
