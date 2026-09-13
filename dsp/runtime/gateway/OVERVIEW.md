---
title: Runtime Gateway overview
status: current
last_verified: 2026-09-02
---

# Runtime Gateway

`runtime/runtime-gateway` is the closed owner-private transport for one managed DSP runtime. It keeps the centralized dashboard outside tenant databases and converts only a small allowlist of operational SDK calls into one-request/one-response Unix-socket messages.

## Request path

```text
authenticated browser session
  -> Access Control reloads active membership and permission
  -> Access Control resolves the organization's ready installation
  -> dashboard runtime router derives the connector from server configuration
  -> runtime gateway verifies protocol version and expected runtime identity
  -> tenant-local DispatchClient
  -> tenant-local Auth Broker, Collection Manager, and publication stores
```

The browser never receives or submits a runtime key, installations root, Unix-socket path, host, port, URL, database path, service name, or command. The gateway is not an HTTP listener and is not exported through the public SDK.

## Protocol

Protocol version `1` accepts exactly one newline-terminated JSON request per connection:

```json
{
  "protocolVersion": 1,
  "runtimeKey": "<server-selected-runtime-key>",
  "action": "system.status",
  "input": {}
}
```

`runtimeKey` is internal routing evidence. The gateway compares it with its process-bound runtime identity on every request and never echoes the value in a response.

Allowed actions are:

- `health` with `{}`;
- `system.status` with `{}`;
- `workforce.day` with `{ "query": <closed-workforce-day-query> }`;
- `workforce.employees` with `{ "query": <closed-workforce-query> }`;
- `workforce.employee` with `{ "code": <four-character-employee-code> }`;
- `sync.status` with `{ "id": <sync-id> }`;
- `sync.run_now` with `{ "id": <sync-id>, "options": <closed-run-options> }`.

Unknown actions and fields fail closed. Inputs are validated again in the gateway process before they reach the runtime-local SDK. The server returns one closed transport envelope containing a normal sanitized SDK result. Stable transport failures are `invalid_request`, `runtime_identity_mismatch`, `runtime_protocol_mismatch`, and `runtime_gateway_unavailable`.

Current limits are code-owned:

- request: 16 KiB;
- response: 300 KiB;
- concurrent connections: 64;
- request/socket deadline: 15 seconds;
- Unix-socket path: at most 107 bytes.

The strict JSON parser rejects duplicate object keys, non-finite values, trailing content, carriage returns, and multiple messages on one connection.

## Runtime composition

`src/managed-runtime.js` reconstructs the managed layout from the complete explicit environment rendered by the Provisioner. Every projected value must equal the deterministic path derived from the process-bound runtime key. The gateway rejects missing roots, fallback roots, symlinks, wrong ownership, wrong modes, replaced directories, wrong devices, and a socket outside `<runtime-root>/runtime-gateway.sock`.

It deliberately does not call `resolveLocalRuntimePaths()` and does not create a tenant-local Access Control store. It constructs a real `DispatchClient` from tenant-local adapters for:

- Auth Broker metadata and readiness;
- Collection Manager health;
- authenticated synchronization coordination;
- Paycom publication health;
- workforce reads.

Provider credential setup is not an exposed gateway capability. The Auth Broker and Collection Manager are already supervised by systemd; the gateway checks the existing broker rather than attempting a second lifecycle owner.

## Socket and process boundary

The gateway listens only on `<runtime-root>/runtime-gateway.sock` with exact mode `0600` inside an exact-mode `0700` runtime directory. Startup removes a stale socket only after validating its type, ownership, mode, canonical identity, and proving no process accepts a connection. Client calls pin and compare socket device/inode identity before and after each exchange.

Managed service-plan version `3` installs four units per configured runtime in order:

1. Auth Broker;
2. Collection Manager;
3. Runtime Gateway.
4. outbound Runtime Agent.

The gateway unit depends on the first two, starts through the same trusted `env --ignore-environment` launcher, uses a closed environment, and is restricted to Unix sockets. The Runtime Agent unit depends on the gateway and has its own owner-private status socket. The Provisioner reads back exact unit bytes, arguments, working directory, cgroup, process environment, socket ownership, and component health. Failure or cancellation uses the existing fenced service compensation and restores the complete prior service state exactly.

Owner-only Unix modes isolate other operating-system users but do not isolate mutually hostile processes running as the same Unix account. Per-DSP service-account/container isolation remains a separate deployment requirement before a broader pilot.

## Dashboard routing

`dashboard/server/runtime-router.js` accepts only the installation object returned by `AccessControlService.runtimeFor()`. It requires:

- an authenticated session;
- an active current membership with the requested permission;
- an active organization;
- a ready installation whose organization ID matches the selected organization;
- a valid server-owned runtime key;
- pinned private installation and runtime directories.

`local` continues to resolve to the existing local `DispatchClient`, preserving the reference installation. Managed keys resolve under the optional server-side `DISPATCH_INSTALLATIONS_ROOT`; absence of that root makes managed installations unavailable rather than selecting a fallback.

Connectors may be cached by server-owned runtime key, but authorization is never cached: Access Control reloads session, membership, role, organization, and installation state on every HTTP request. A suspended membership/organization or changed installation therefore fails before use of a cached connector.

## Current activation boundary

Gateway readiness proves private transport identity and access to supervised Auth Broker/Collection Manager health. It does not by itself prove provider credentials, provider authentication, collection completeness, or a first publication, and it never writes installation state. The managed activation controller now uses gateway identity/health as one of nine independent gates; Access Control commits `ready` only after protected provider authentication, exact first-collection completion, publication audits, and final infrastructure read-back also pass.

## Verification

Run the component gate:

```bash
./runtime/gateway/scripts/verify
```

Run the dashboard routing gate:

```bash
npm run build --prefix dashboard
npm test --prefix dashboard
```

Run the actual temporary user-systemd gate:

```bash
npm run verify:systemd --prefix core/provisioner
```

The real gate creates two isolated four-service fixture runtimes plus an independent central fixture hub, runs one through the durable seven-stage pipeline, validates cross-runtime identity rejection, exercises Agent-backed and direct gateway status plus `sync.run_now`, verifies worker execution and restart/start-limit behavior, rolls back the fixture units, and confirms the existing reference services retain their PIDs.
