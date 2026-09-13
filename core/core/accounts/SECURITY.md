---
title: Access Control security contract
status: current
last_verified: 2026-09-03
---

# Security contract

## Trust boundary

Human authentication and tenant authorization are separate from provider authentication. This component must never receive Paycom/Amazon credentials, browser cookies, CDP endpoints, vault records, or collector leases. The Auth Broker must never become the human account database.

## Identity and secret storage

- Email addresses are normalized for identity matching.
- Passwords are never normalized or trimmed and must contain 12–128 characters.
- Passwords use scrypt-v1 with `N=32768`, `r=8`, `p=1`, a random 24-byte salt, and a 64-byte output.
- Unknown-account authentication performs equivalent scrypt work.
- Session, invitation, and browser platform-control values contain 256 random bits and are stored only as SHA-256 hashes.
- The access database and directory must be owner-only regular paths outside the source tree.
- Browser storage never receives session or invitation tokens; the session token remains in an `HttpOnly` cookie.

## Tenant invariants

1. Account creation alone grants no organization access.
2. DSP-owner and member API paths contain no organization identifier; every organization operation derives the DSP from the session's active membership.
3. Platform ownership does not imply DSP workforce access.
4. Organization switching sends a membership ID, and the server derives the organization from that existing active membership.
5. Runtime selection comes from the server-owned installation registry.
6. Pending installations cannot call operational SDK endpoints.
7. A DSP abbreviation, station code, URL slug, request body, or opaque record ID is never authorization.
8. Authorization errors do not return workforce identities or runtime routing metadata.

## Installation authority invariants

1. Access Control schema `6` is authoritative for installation lifecycle, release and manifest revisions, current job, organization/runtime binding, fixed-stage lifecycle jobs, backup inventory, hash-only Runtime Agent authorities, hash-only browser platform-control references, and platform-mutation idempotency; the Provisioner database is an executor journal.
2. Only `platform.installations.manage` plus the separately enabled installation-operator composition may create a closed provision/retry request, and tenant roles cannot receive that permission.
3. One transaction checks lifecycle/revision/idempotency and writes the outbox request plus `provisioning`; browser organization/status/invitation commands use a separate actor/action/key ledger. Direct database edits are not an operational interface.
4. A Provisioner live job is unclaimable until Access Control records its exact server-generated ID and the Provisioner acknowledges that binding.
5. Every live host mutation revalidates the same Access Control organization/manifest/runtime/current-job authority while holding the authority transaction.
6. Owner acceptance moves `waiting_for_owner -> waiting_for_provider_auth` in the membership transaction. Provider credentials and sessions never enter Access Control. Protected credential setup owns a durable installation-local worker/fence/expiry lease; a current setup lease blocks both activation and another setup worker, and every service/vault/ingress mutation revalidates and renews it before execution.
7. Activation jobs are leased and fenced. Only the current unexpired worker/fence may heartbeat, fail, commit, or initiate a deadline cancellation; process loss reclaims with a larger fence. Long manager polling renews the lease. A stale worker exits without cancelling the shared idempotent run or batch, allowing its replacement to resume.
8. `ready` requires all nine gates for the current manifest/runtime/job plus a closed, digest-verified, fresh evidence bundle that independently binds the exact manager batch to active Paycom publications. Job success, private evidence, installation ready, and organization active commit and read back in one transaction.
9. Failed/partial publication, stale authority, unverified legacy managed ready, and unknown errors remain non-ready. Only exact `local-dsp -> local` may preserve legacy ready during schema migration.
10. Browser-safe platform/setup projections exclude organization/runtime/job/invitation identities, infrastructure details, provider responses, credentials, sessions, publication identifiers, evidence bundles, and workforce data. Platform mutations resolve only an expiring session/user/organization/purpose-bound random control reference in a JSON body. The private activation row may retain only the closed evidence contract needed to prove readiness; it is never a dashboard or public SDK DTO.
11. Lifecycle jobs are authority-scope/idempotency-key bound, one-active-job constrained, leased, and fenced. Their fixed stages and bounded aggregate receipts never contain a path, command, credential, provider response, or business record.
12. Restore accepts only an available backup already bound to the same organization/runtime and only while suspended. Upgrade accepts only a different release from the server-owned catalog and advances release/manifest authority only after backup, target health, publication continuity, and journal commit.
13. Resume rechecks infrastructure and exact publication continuity without provider authentication, collection, or publication. Decommission retains data and a final backup; permanent deletion is a separate decommissioned-only server-local operation with literal approval.

## Invitation invariants

- The organization, email, and role are fixed before token generation.
- Tokens are one-time, revocable, hashed at rest, and expire.
- Initial platform-owner invitations can be revoked idempotently from the owner-private bootstrap command before acceptance.
- Pending-owner and per-DSP/per-email uniqueness is checked inside the write transaction and enforced by partial unique indexes.
- Local invitation links keep the token in the URL fragment, inspect it through a JSON body, and clear the fragment after acceptance so reverse-proxy request logs and referrers do not receive it.
- Existing accounts must sign in with the exact invited email.
- Initial ownership uses a platform-issued invitation; additional Owners can be invited or assigned through team management.
- Only an authenticated platform owner may create a DSP shell or replacement initial-owner invitation.
- Without outbound email, invitation paths are returned only once to the authorized creator or written by the bootstrap command to an owner-only secret file.

## Role invariants

- Every DSP has exactly four fixed system roles: Owner, Manager, Dispatcher, and Driver.
- All four currently share the complete DSP permission catalog, including `organization.owner`, but never platform authority.
- Custom role creation and all role edits/deletions are rejected by the service; `roles.manage` is not granted.
- An actor cannot grant permissions they do not possess.
- System roles cannot be edited or deleted.
- All four roles can be invited and assigned. The last active Owner cannot be demoted or removed.
- Schema 13 migrates Administrator to Manager, Viewer to Driver, and custom roles to a matching standard name or Dispatcher. Existing canonical IDs, memberships, and invitation tokens/statuses are preserved; retired role references are repointed transactionally.
- Self-role change and self-removal are rejected.
- Role and membership changes are checked on every request rather than trusted from stale browser state.

## HTTP invariants

- Platform target references are random, hashed at rest, bound to the issuing session/user/organization/purpose, expire after 15 minutes, never enter a URL, and are not authorization without a fresh permission check.
- Platform mutations use fixed routes and exact bodies. Organization/status/invitation commands use durable actor/action/idempotency-key request matching; provision/retry uses the installation/authority-scope/key/canonical-operation outbox record. Replay never reissues a one-time invitation value.
- Protected routes require an opaque session cookie.
- Mutations require JSON, same-site browser context, and the session's CSRF token.
- Login attempts are bounded in memory by address/account and across accounts per address; invitation inspection/redemption is also address-bounded. Failures remain generic.
- Public cookies use `__Host-dispatch_session` with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Domain` attribute.
- Responses containing identity, invitation, membership, or workforce information are `no-store`.
- Static content keeps the restrictive dashboard CSP, frame denial, referrer denial, and permissions policy.

## Public deployment boundary

The invitation-only Dashboard is public only through the exact `https://dispatch.example.test` Cloudflare Tunnel route to its loopback listener. Public mode requires exact Host, Cloudflare HTTPS proof, exact mutation Origin, secure host-only cookies, managed WAF/DDoS protection, and no-store application responses. Bot Fight Mode is disabled during testing because its zone-wide policy challenged scripted/headless acceptance; review sibling subdomains and automated clients before production enablement. Do not expose an origin port, ordinary reverse proxy, Funnel, wildcard/per-DSP route, Runtime Gateway, Provisioner, or lifecycle executor. Verified outbound email/recovery, administrator MFA/passkeys, stronger distributed rate limiting/alerting, backup/incident review, and final independent review remain hardening responsibilities.
