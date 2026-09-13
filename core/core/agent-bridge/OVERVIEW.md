---
title: Runtime Agent bridge
status: current
last_verified: 2026-09-04
---

# Runtime Agent bridge

`core/runtime-agent-bridge` is the narrow same-host cross-account transport for the rootless DSP model. One root-owned bridge process serves one server-derived runtime identity.

The downstream Unix socket is owner `0600` for the DSP account inside a root-owned non-writable directory. The bridge validates strict bounded Runtime Agent frames, rejects a registration for any other runtime, and forwards only to the configured central owner-private Hub socket. It persists and logs no registration token and exposes no TCP listener, path selector, command, shell, URL, generic proxy, or engine operation.

The central Hub remains the authentication and current-authority boundary. The bridge is transport containment, not an alternate authorization database.

The executable requires root and receives only systemd/server-owned environment. The current two-account fixture proves the socket boundary; durable production bridge lifecycle belongs to the future privileged host helper.

See Rootless DSP runtime containers.
