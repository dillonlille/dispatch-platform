# Security and operational boundaries

- The API binds to loopback. Production configuration requires a canonical HTTPS
  origin and native provider mode. TLS/reverse-proxy installation is a later host
  setup step; it is not performed by this repository.
- Sessions use random opaque tokens, hashes at rest, HttpOnly/SameSite cookies,
  expiry and user-version revocation. Passwords use scrypt. Mutations require the
  expected Origin, JSON content and a session-bound CSRF token.
- DSP views are server-authorized and signed. IDs never become arbitrary paths;
  storage checks ownership, permissions, symlinks and hard links. Directories
  require mode 0700 and private files mode 0600.
- Provider credentials use AES-256-GCM with a per-DSP key and DSP/provider binding.
  These keys live on the same trusted host. Encryption protects accidental
  disclosure or cross-DSP ciphertext reuse; it does not defeat host compromise.
- Browser profiles, session snapshots, screenshots and CDP access are credentials
  in practical terms. They stay private and are never returned to ordinary
  members. Browser assistance is restricted to DSP owners/platform owners.
- Native browser workers have separate user, process, network and filesystem
  namespaces. Egress permits specific provider hosts on HTTPS 443 and denies
  private IP destinations. The test-only fixture exception maps one synthetic
  hostname to one local test port. No arbitrary URL comes from the dashboard.
- Collection workers mount only application code and a single browser control
  socket. They receive no vault directory, profile mount or platform environment.
  CDP grants the authenticated browser session; it is not a general-purpose
  untrusted-code execution service.
- Production Chromium retains its internal sandbox. This machine’s current
  AppArmor policy prevents nested sandbox namespaces. Native fixture tests keep
  the outer boundary but explicitly omit the inner sandbox for their local-only
  browser. There is no automatic production fallback. A compatible production
  browser host must be verified during the later host setup.
- Audit records contain controlled action names and error codes, not provider
  passwords, OTPs, reset tokens, raw HTTP bodies or browser diagnostics. Native
  fixture diagnostics are available only to local tests.
- Account changes in the trusted control plane require full staging validation.
  Preview may not migrate the shared account schema. Schema rollback is never
  inferred from a code rollback.

## Provider acceptance

No real Paycom login or archived credential was used for this rebuild. The native
adapter uses retained public roster/timecard validation contracts plus a new
shared worker flow. Provider HTML, authentication prompts, pay-period totals,
additional pay-code rows and account-specific policies must be verified with the
authorized Dev account before live collection is approved. Unsupported or invalid
records fail collection and preserve the prior publication. Punch-pair hours that
the provider does not explicitly supply are shown as unavailable, not invented.

## Recovery

An offline backup takes both API locks and copies consistent SQLite snapshots and
private DSP/platform files with a checksum manifest. It excludes transient worker
runs, release artifacts and activation backups. Restore requires an empty target,
verifies all listed files, revokes sessions/invitations/reset links, cancels pending
collections and clears release references so stale absolute paths are not reused.

Keep backups private and protect their encryption keys together with their data.
Reimport the desired code artifact and explicitly configure the restored host
before resuming work. Backup does not include the archived legacy platform.
