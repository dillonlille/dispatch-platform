---
title: Auth Broker security model
status: current
last_verified: 2026-09-02
---

# Auth Broker Security Model

## Current scope

This component protects credential storage, performs credential-bearing provider login, owns private Chrome processes and provider/profile-scoped browser state, and issues short-lived full-CDP browser leases. The Paycom adapter has crossed a separately supervised provider-login and protected-application handoff boundary. Amazon Logistics has a registered fixture-verified adapter but has not crossed a live login or lease boundary.

Live acceptance requires more than a generic shell: the provider adapter must prove the exact protected application before issuing a lease. Current profile enrollment, latches, browser state, and provider readiness are installation-local and are not repository documentation.

## Security guarantees

- Credential objects are validated against closed provider-specific schemas.
- Paycom requires exactly client code, username, password, and five distinct indexed PIN strings.
- Amazon Logistics requires exactly username and password. MFA, CAPTCHA, security challenges, lockout, unknown origins, and unknown layouts are classified separately and fail closed.
- Credential plaintext is encrypted with AES-256-GCM using a fresh 96-bit IV and 128-bit tag for each write.
- AEAD associated data binds ciphertext to vault version, profile ID, and provider ID.
- The 256-bit master key is stored separately from encrypted SQLite rows.
- Key, database, and socket are mode `0600`; credential and state directories are mode `0700`.
- Storage rejects symlinks, foreign ownership, unexpected hard links, unsafe modes, non-canonical paths, incomplete key/database pairs, unsupported schemas, oversized databases, and invalid public metadata.
- Integrity verification authenticates and decrypts every bounded credential profile.
- Public IPC has no secret read, reveal, dump, or export operation.
- Plugins receive full browser access only after broker-side authentication; no credential object crosses the IPC boundary.
- Browser leases are bound to profile, collector label, run ID, and a bounded lifetime measured with a monotonic deadline. Release, expiry, profile lock, or broker shutdown terminates Chrome. Paycom and Amazon Logistics browser/device state remains owner-private and bound to the auth profile; profile replacement and removal delete it before credential mutation.
- Collector and run identifiers are audit/lifecycle labels under the current same-Unix-user trust model; they are not independent process identity proofs.
- Chrome runs in a private profile with extensions and component background pages disabled. Persistent profile metadata is identity-bound. Runtime markers include boot ID and process start ticks, but startup reconciliation never kills from a persisted PID; it blocks if a same-user process names the exact profile directory and cleans only inactive stale state.
- Pending authentication is cancelled and drained before profile lock or broker shutdown completes.
- The official client keeps an acquisition connection open; disconnect or request deadline cancels the pending login and destroys its browser.
- Before the adapter can submit credentials, the broker durably records a pending-attempt latch. Invalid credentials impose a cooldown. Restart or an approved local interruption after submission becomes internally observation-recoverable: Paycom may clear that latch only by proving an already-authenticated exact Timecard Search session without decrypting or submitting credentials/PINs. Provider ambiguity, rejected credentials, account lockout, CAPTCHA/MFA/security challenge, operator lock, and failed recovery remain manual.
- Browser status checks process liveness, and cleanup verifies that the Chrome process group exited before removing its profile. Failed cleanup is retried immediately and then by a background reaper while the broker remains alive.
- Socket requests use a closed action/field contract, strict duplicate-key-rejecting JSON, bounded input/output, connection limits, and timeouts.
- Enrollment reads secrets only from `/dev/tty` with terminal echo disabled and restored on normal error, signal exit, and process exit paths. Provider values are entered twice and mutation is refused while the broker is running.
- Managed DSP enrollment uses the same helper with one authority-derived runtime projection after the complete configured service set, including the Runtime Agent, is stopped/read back. Access Control, Provisioner jobs, browser/SDK requests, argv, and environment never carry credential values; successful metadata becomes only a provider-auth readiness input.

## Threat boundary

Encryption at rest does not protect against an attacker who controls the broker's operating-system account while the key is present. A process running as the same Unix user can generally read both the key and database files despite the files being mode `0600`. Root, kernel compromise, process-memory inspection, and physical-memory compromise are also outside this component's protection boundary.

For a stronger production boundary, run the broker under a dedicated service account and authorize collectors through a separately reviewed IPC identity mechanism. Socket mode `0600` authorizes the owning Unix account, not individual executables.

Full CDP access intentionally makes an installed plugin trusted with the authenticated browser session. Such a plugin can access cookies, local/session storage, authorization headers, and any account data available to the browser. This design protects primary credentials from ordinary plugin handling; it does not make mutually untrusted plugins safe to run against the same authenticated account. A username may also be visible in Paycom's authenticated UI even though the broker never exports the stored credential record.

Persistent Paycom and Amazon Logistics browser profiles contain authenticated session and trusted-device material. They are not encrypted by the credential vault and must be protected like active login sessions. No broker operation exports them. Do not copy them to logs, source control, or general backups; use profile replacement/removal to reset them.

The loopback CDP endpoint has no independent bearer-token gate. Its random port is disclosed only in the owner-private lease response and `DevToolsActivePort` file, but another process running as the broker's Unix user may be able to discover it. Use a dedicated service account or stronger process isolation if same-user plugins are not mutually trusted.

Collector wrappers should use a short renewable lease, release on normal completion and termination signals, and stop renewing when the collector dies. An uncatchable collector kill can retain a browser only until the short TTL expires. When deployed with the provided systemd unit, `KillMode=control-group` also prevents Chrome descendants from surviving broker service termination.

`manual_verification_required`, `mfa_required`, `captcha_required`, and `security_challenge` remain terminal for the current acquisition. Observation recovery is a separate credential-free proof path available only for an internally reasoned interruption latch; it cannot continue through logged-out or credential/PIN-bearing pages. All genuine provider-side manual states destroy the browser and require operator review.

The owner-only `unlock` operation clears a durable attempt/operator latch but cannot read or alter credentials. Operators must review provider account state before unlocking. Automated collectors never invoke `unlock`; observation recovery is enforced inside the broker.

The JavaScript runtime cannot guarantee complete zeroization of immutable strings or copies made by the runtime. Explicit plaintext buffers and the loaded key buffer are zeroed where practical, but process memory must still be treated as sensitive.

## Operational requirements

- Never send real credentials or PINs through chat.
- Enroll or replace credentials only from a private local terminal.
- Do not run enrollment while screen sharing or recording.
- Back up the database and master key securely; loss of the key makes the encrypted rows unrecoverable.
- Do not copy the master key into source control, logs, tests, manifests, or ordinary configuration.
- Keep the parent database and component directories non-group-writable so another group member cannot replace private child directories.
- Production service packaging should disable core dumps, restrict filesystem access, set a strict umask, and isolate the broker account.
- Node's built-in `node:sqlite` API is experimental in the installed Node 22 runtime. Pin the runtime or replace it with a maintained SQLite binding before declaring a long-term production support policy.

## Verification commands

```bash
./tooling/build
./tooling/test
./tooling/verify
./tooling/start
./tooling/health
```

The test suite uses non-production credentials in owner-private temporary directories and covers encryption, plaintext absence, AAD substitution, ciphertext tampering, schema tampering, metadata tampering, unsafe filesystem objects, incomplete storage, profile bounds, strict JSON, socket limits, live-instance exclusion, private authentication, full-browser handoff, pending shutdown/lock cancellation, disconnected clients, revocation, strict Paycom and Amazon Logistics routes/states, post-submit transitions, persistent-profile reconciliation/deletion, stale-PID refusal, and credential-free responses. Live acceptance currently covers Paycom only. Amazon fixtures prove that the classifier requires conservative capability evidence; they do not prove the current site exposes that evidence, credential validity, MFA behavior, or clean-target browser handoff.
