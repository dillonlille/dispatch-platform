---
title: Access Control overview
status: current
last_verified: 2026-09-03
---

# Access Control

This component is the human identity and DSP authorization control plane for Dispatch.

## Owns

- website user identities, password hashes, and authenticated password rotation;
- opaque server-side sessions and CSRF tokens;
- DSP organizations and station metadata;
- explicit user-to-DSP memberships;
- protected system roles and constrained custom roles;
- platform and DSP invitation lifecycles;
- authoritative organization-to-runtime installation lifecycle, revision, and current-job binding;
- durable provisioning outbox requests, activation fencing, lifecycle jobs, release authority, and backup inventory;
- bounded access audit events.

## Does not own

- Paycom or Amazon provider credentials;
- provider browser sessions or cookies;
- provider login automation;
- workforce, timecard, or CDF data;
- collection execution or scheduling;
- arbitrary runtime endpoints or commands.

Those boundaries remain with the Auth Broker, plugins, Collection Manager, and SDK respectively.

## Source

- `src/store.js` — private SQLite schema and persistence
- `src/service.js` — identity, invitation, membership, role, permission, and session policy
- `src/installation-authority.js` — server-owned managed manifest projection
- `src/installation-provisioning.js` — Access Control outbox, Provisioner acknowledgement, and terminal reconciliation
- `src/installation-activation.js` — provider-activation lease/fence and atomic `ready` commit
- `src/installation-lifecycle.js` — durable backup/restore, upgrade, suspension, decommission, and destruction authority
- `src/passwords.js` — versioned scrypt hashing and constant-work fallback
- `src/validation.js` — closed bounded inputs
- `src/permissions.js` — platform and tenant permission catalogs
- `tests/access-control.test.js` — focused security and isolation acceptance

## Runtime

Version `0.4.0` owns schema version `6`. The database is `<data-root>/access-control/access-control.sqlite3`, with an owner-only directory and file. Schema `2 -> 6` preserves the conservative lifecycle adoption, browser controls, and exact `local-dsp -> local` compatibility state while adding durable release/lifecycle state and per-installation Runtime Agent authority digests, generations, and revocation. Raw Agent tokens remain only in private per-runtime files. New DSPs receive pending installation records; no browser-provided address is accepted.

Only `platform.installations.manage` may create a target-free provision/retry outbox request. The Provisioner job remains unclaimable until Access Control records its exact server-generated job ID and the Provisioner durably acknowledges that record. Owner acceptance advances `waiting_for_owner -> waiting_for_provider_auth` in the same transaction as membership creation. Protected setup acquires a durable worker/fence/expiry lease on the installation; concurrent setup and activation are denied while it is current, every credential or service mutation renews it, and stale workers cannot mutate after reclaim. Managed activation stores profile/provider metadata, a positive-test timestamp, job/manifest revisions, leases/fences, and a closed first-publication evidence bundle—never a provider secret or session. Only the current unexpired worker/fence may heartbeat, fail, or commit. The sole `ready` write validates the current activation job, all nine server-built gates, and the fresh evidence digest, then persists job success/evidence, installation readiness, and organization activation in one Access Control transaction with exact read-back. Public projections omit setup leases, evidence, and publication identities.

The private Dashboard now exposes only fixed Access Control console capabilities. Its platform list returns an expiring opaque control reference and sanitized organization/installation state, not organization/runtime/job identity. CSRF-protected idempotent create, invitation, status, provision, and infrastructure-retry requests resolve that reference server-side. The setup status is target-free. For OCI installations, owners submit a fixed Paycom credential form into their runtime's vault through the private Agent, then the reconciler verifies and activates the DSP. Access Control schema 9 persists a credential-free onboarding ledger with expiring leases and fences. Platform removal and separate permanent deletion queue lifecycle jobs after exact-name confirmation. Runtime roots, keys, units, commands, endpoints and provider profile selectors remain unavailable to HTTP callers; credentials are accepted only by the owner setup input and never returned.

The separate server-only lifecycle controller uses Access Control's current lease/fence around each fixed host mutation. Backup/restore, upgrade rollback, runtime suspension/resumption, retained removal and restoration, and permanent destruction use fixed lifecycle jobs. Private Dashboard routes can request removal/restoration and password-confirmed deletion; host mutations remain absent from the HTTP process, public SDK, and Runtime Gateway.

See [`SECURITY.md`](SECURITY.md) for the authorization and storage boundary.

Email-first creation atomically adds a pending business profile and provisioning request with the owner invitation. Submitted profiles are applied once infrastructure is prepared. Durable platform rollout records coordinate sequential lifecycle upgrades, block on unready DSPs or failures, and retain restart and retry state. See platform administration.
