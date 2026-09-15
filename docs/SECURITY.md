# Security and operational boundaries

- The API binds to loopback. The hosted Dev configuration requires a canonical HTTPS
  origin and secure cookies. Cloudflare Tunnel exposes only the application, with
  a catch-all 404. Dev accounts, configuration and state are independent.
- Sessions use random opaque tokens, hashes at rest, HttpOnly/SameSite cookies,
  expiry and user-version revocation. Fresh Rust passwords use Argon2id. Mutations require the
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
- Native Chromium retains its internal namespace and seccomp sandboxes. On this
  host, Dev uses a root-owned bubblewrap copy and a path-specific AppArmor profile
  to permit nested namespaces. The system-wide user-namespace restriction remains
  enabled. `npm run test:browser-host` verifies the real browser sandbox without
  visiting a provider. Legacy local fixture tests can omit the inner sandbox;
  native provider sessions have no fallback that disables it.
- Audit records contain controlled action names and error codes, not provider
  passwords, OTPs, reset tokens, raw HTTP bodies or browser diagnostics. Native
  fixture diagnostics are available only to local tests.
- Standalone Dev controls its own account schema and can test complete account
  changes independently. Schema rollback is never inferred from code rollback;
  the initial Rust credential-format change requires explicit fresh Dev state.

## Provider acceptance

No real Paycom login or archived credential was used for this rebuild. The native
adapter uses retained public roster/timecard validation contracts plus a new
shared worker flow. Provider HTML, authentication prompts, pay-period totals,
additional pay-code rows and account-specific policies must be verified with the
authorized Dev account before live collection is approved. Unsupported or invalid
records fail collection and preserve the prior publication. Punch-pair hours that
the provider does not explicitly supply are shown as unavailable, not invented.

## Recovery

An offline backup takes the exclusive platform lock and copies consistent SQLite snapshots and
private DSP/platform files with a checksum manifest. It excludes transient worker
runs, release artifacts and activation backups. Restore requires an empty target,
verifies all listed files, revokes sessions/invitations/reset links, cancels pending
collections. Rust state contains no legacy in-dashboard deployment registry.

Keep backups private and protect their encryption keys together with their data.
Install the desired compatible Rust code artifact and explicitly configure the restored host
before resuming work. Backup does not include the archived legacy platform.
