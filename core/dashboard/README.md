---
title: Dashboard source guide
status: current
last_verified: 2026-09-07
---

# Dispatch dashboard

The dashboard presents the authenticated Dispatch UI. In split mode it serves
static assets and forwards `/api/` requests to the independently running
`dispatch-api` service. Backend composition and HTTP implementations live in
`core/api/`; account authority lives in `core/accounts/`.

Run `bin/dispatch-dashboard --api-origin http://127.0.0.1:4311` for the UI-only
service. Without `--api-origin`, the command retains the combined compatibility
launcher for existing deployments. See [Dispatch API](../core/api/README.md) for
service ownership and migration details. Frontend plugins use `dispatch-sdk/ui`
for session-aware requests, shared controls and plugin settings.

## Date and time

Event timestamps are UTC instants in storage and API responses. The dashboard
formats them using the device timezone by default. Settings → Date & time offers
a validated IANA timezone override, saved per account on the current browser;
it follows the user while viewing other DSPs and synchronizes across tabs.

Plugins can use `useTimezone()` from `frontend/src/lib/timezone.tsx` and
`dateTime(value, timeZone)` from `frontend/src/lib/date-time.ts` for event times.
The same provider covers connection checks, sync activity, audit events,
invitations, backups and release timestamps.

Business dates are different: Paycom timecard dates, punch clock readings and
report boundaries belong to the DSP's business timezone. Use `useBusinessToday`
for the current DSP date and the calendar helpers for labels and day navigation.
Do not parse a date-only string as an event timestamp or convert a punch clock
reading into the viewer's timezone. A display preference never changes a DSP's
collector configuration or schedule. New DSP onboarding explicitly records the
business timezone, initially detected from the owner's browser.

Existing DSP corrections must keep the organization timezone and plugin source
timezone consistent while collection is idle. Keep prior publications and run
receipts unchanged; new runs capture the corrected source configuration.

## Start

Read-only operational mode:

```sh
./bin/dispatch-dashboard
```

Permission-gated private operator modes:

```sh
./bin/dispatch-dashboard --operator
./bin/dispatch-dashboard --operator --installation-operator
```

`--operator` enables **Sync now** only for a selected member with `sync.run`. The separate `--installation-operator` capability enables fixed platform provision/retry outbox requests; it does not run the private reconciler, systemd, credential setup, or activation in the HTTP process. The service template omits `--installation-operator` by default; enabling it requires a deliberate trusted server-owner unit change and read-back.

For local development, open `http://127.0.0.1:4310`. The installed service is instead configured for the canonical `https://dispatch.example.test` origin and is reached only through the supervised Cloudflare Tunnel. Public-origin mode requires secure cookies, exact Host and mutation Origin validation, and Cloudflare HTTPS proof; direct loopback/tailnet requests without that proxy metadata fail closed. Human login and organization authorization are always enabled.

For already-authoritative ready managed installations, the server may receive an owner-private `DISPATCH_INSTALLATIONS_ROOT`. This is deployment configuration, not a browser/HTTP setting. Its runtime router derives and pins each managed gateway socket below that root.

## DSP removal and restoration

Active DSPs offer **Remove DSP**. Removal immediately signs out DSP users and prevents sign-in, pauses queued onboarding and backup work, stops and disables services, and keeps the DSP's data, credentials, service definitions, and completed backups. Existing backups are protected from expiration and are not newly exported while removed. A user can belong to only one DSP; platform support uses the separate DSP viewing context.

The **Removed** tab contains removing, removed, restoring, and deleting DSPs, including failed operations. Once shutdown is complete, **Restore DSP** starts and verifies the retained runtime, restores its previous collection schedule, re-enables account access, and resumes normal backup scheduling and retention. Previously issued user sessions remain invalid. Earlier removals that deleted service definitions are migrated with their saved schedule; restoration reinstalls those definitions. Failed restoration keeps access blocked and remains retryable.

**Permanently delete DSP** is available only after removal. It requires the signed-in Platform Owner's password, checked on the server with permissions, session validity, CSRF, revision checks, and password-attempt throttling. The password is not saved in lifecycle jobs or audit records. Deletion removes DSP data, files, accounts, credentials, and local and remote backups. Native DSPs remain visible until credential and Core account cleanup finishes. Full-platform backups containing the deleted DSP are also erased; other DSPs' individual backups remain.

## Initial platform owner

Create the initial platform-only owner from a private server terminal using the same runtime paths as the dashboard:

```sh
./bin/dispatch-access-admin owner-create
# Recover access or replace the login email/password later:
./bin/dispatch-access-admin owner-list
./bin/dispatch-access-admin owner-recover
```

The commands prompt for credentials privately through `/dev/tty`; no passwords are accepted in arguments, environment values, or pipes. Recovery revokes existing sessions. The optional invitation-based `bootstrap --email OWNER_EMAIL` flow remains available and defaults to no organization. See platform administration for setup and recovery details.

Everyone signs in on the same page. Platform owners land in the separate core-hosted console with DSPs, Updates, Backups, blank Plugins, Diagnostics, and Settings. DSP users retain their organization-scoped pages. The dashboard no longer creates a local DSP at startup.

## Access a DSP as its owner

Platform owners can choose **View** from a DSP's action menu or details panel to use its existing owner interface with full owner permissions for support. A persistent banner names the DSP, explains that changes are saved to it, and provides **Exit view**. Team management, roles, invitations, DSP onboarding, and available runtime actions are enabled. Team, roles, invitations, activity, and workspace details use the selected DSP's real data. Home Page and Paycom retain their current placeholder behavior. Account details continue to identify the signed-in platform owner.

Viewing lasts up to 15 minutes, survives refresh in that tab, and leaves other tabs in their existing context. It does not create a membership or sign in as the owner. The server validates a separate, session-bound viewing reference on each request and applies the same permissions, CSRF validation, backup locks, and runtime readiness checks as DSP owner requests. The context can change only the selected DSP; exit it to use platform controls. Suspended or removed DSPs cannot be viewed. Expired or unavailable views return to the platform console with an explanation. Entering a view records `organization.view.start` under the platform account in the DSP activity history. DSP changes and sync requests are attributed to that platform account. Account security settings and sign-out operate on the signed-in platform account.

## Diagnostics

Platform Owners can use **Diagnostics → Deploy test DSP** to create a native DSP with synthetic employees and timecards. Each request creates a clearly named `TEST DSP`, assigns the requesting Platform Owner as its owner without sending an invitation email, and queues normal provisioning. The page shows progress; the DSP remains available until explicitly deleted through the DSPs page. The same removal, restoration, and password-confirmed permanent deletion controls apply.

The private installation reconciler seeds only DSPs recorded in the durable diagnostics table, then uses the existing activation authority with explicitly synthetic provider evidence. The fixed private Runtime Agent command accepts only the recorded DSP identity, refuses existing non-diagnostic publications, and persists its result for retries. It is excluded from public SDK capabilities. Real provider authentication and collection are not exercised; collection schedules are manual and the sync stays stopped.

Diagnostics requires native provisioning to be enabled. Schema 12 adds the diagnostics records while retaining existing organizations, identities, and lifecycle data. The HTTP process queues work and never executes host commands.

Optional non-secret local-DSP configuration:

```sh
DISPATCH_DASHBOARD_DSP_NAME='Example Delivery LLC' \
DISPATCH_DASHBOARD_STATION='TST1' \
./bin/dispatch-dashboard --operator
```

The installed service reads optional display settings from `<local-root>/config/dashboard.env`. User name and role now come from the authenticated account and membership rather than display-only environment values.

## Frontend and page scope

The frontend uses React, TypeScript, Vite, Tailwind CSS, and locally owned shadcn/ui components. `frontend/src` owns the shared shell, authentication, DSP management, team administration, and account settings. The Updates and Backups pages mount the existing isolated controllers so their polling, rollout recovery, restore checks, and idempotent requests retain their tested behavior.

Platform owners have **DSPs**, **Updates**, **Backups**, **Plugins**, and **Settings**. DSP members have **Home Page**, **Paycom**, **Team & Roles**, and **Settings**, subject to their existing permissions. Plugins and Home Page contain only a page title and make no workforce or bootstrap requests. Paycom provides the daily Timecard and Employees views described below. CDF and Integrations have no frontend routes; existing protected backend APIs remain available to authorized clients.

`npm run build` type-checks the React source and produces `public/assets/frontend.js` and `styles.css`. The generated JavaScript and CSS are ignored by Git; build them before starting a fresh development checkout. The local Inter font remains tracked. Release packaging builds JavaScript and CSS from the selected commit and includes them in the Core artifact, which runs without frontend build dependencies. The server snapshots the browser assets with content-addressed URLs, preserving cache consistency across releases. A fresh per-response style nonce allows the dialog library to manage scrolling without allowing arbitrary inline scripts or styles.

For an isolated synthetic preview:

```sh
npm ci
npm run build
npm run preview:ui
```

Open `http://127.0.0.1:4339`. Fixture-only accounts are `platform@example.test` and `owner@example.test`, both with password `synthetic preview password`. The preview uses a disposable database. Backup execution is simulated; it does not send emails or change runtimes.

Browser regression checks:

```sh
npx playwright install chromium
npm run test:ui
```

The platform administration page lists DSPs with owner email, runtime health and onboarding status, plus search and Running, Onboarding and Removed filters. Create New DSP opens an email-only dialog. A single Access Control transaction creates the immutable organization and runtime identity, owner invitation and provisioning outbox request. The existing full-detail service API remains compatible with private tooling.

After accepting the invitation, the owner supplies the DSP name, abbreviation, station and timezone. Details submitted during provisioning are retained and applied after the infrastructure worker finishes, without changing the container identity or data paths. DSP details can be completed from Team & Roles or Settings. Paycom remains blank in this frontend scope; provider enrollment is not exposed here.

Manage updates reads the deployment-owned OCI release catalog and starts a durable fleet rollout. The private reconciler queues one verified lifecycle upgrade at a time, pauses on failure or unready DSPs, and records completion only after every current DSP is on the target and ready. New DSPs inherit the target and join an active rollout. Version identifiers remain internal to each DSP; the UI shows platform update selection, progress and history. See platform administration operations for deployment requirements and acceptance checks.

Removal retains runtime data and backups. Permanent deletion remains a separate action. Both are available in each DSP's actions menu, using the existing session-bound control references and confirmation checks.

## Invitation delivery

Dashboard-created DSP-owner and member invitations are delivered through Cloudflare Email Sending as `Dispatch <invites@dispatch.example.test>` when `DISPATCH_EMAIL_ACCOUNT_ID` is present. Public-origin mode refuses invitation creation before Access Control mutation when the adapter is absent; local development without a public origin may retain the one-time manual handoff. The Dashboard reads the API token only from the fixed owner-private `<secrets-root>/email/cloudflare-api-token` file; the token is never accepted through HTTP, argv, or an environment value. The sending request uses the authoritative invitation email, organization, role, expiry, and code-owned `https://dispatch.example.test` origin.

A Cloudflare `delivered` or `queued` result suppresses the raw invitation link in the browser. A deterministic rejection or ambiguous transport result preserves the same one-time link as an authorized manual fallback and is never retried automatically. Platform mutation replays do not send again because Access Control does not return the raw token on replay. Cloudflare Email Preview must remain disabled because message bodies contain invitation capabilities.

The initial platform bootstrap remains an owner-private terminal handoff so no email dependency can weaken first-owner initialization.

## Turnstile protection for sign-in and registration

Cloudflare Turnstile can protect `POST /api/auth/login` and `POST /api/auth/register`.
The Managed widget checks the browser while the user fills out the form. Submitting
requires a fresh token, and the server verifies success, the canonical hostname,
and the exact `login`, `register`, or `forgot_password` action before checking a password or creating an
account. Tokens never enter Access Control, audit records, or logs. Existing account
and address throttling, invitation validity, CSRF, and session checks remain in force.
Rejected login challenges count toward the existing failed-attempt limit; provider
outages do not. Signed-in invitation acceptance retains its session and CSRF checks
without another challenge.

Activation is deployment-owned and opt-in so an unconfigured upgrade does not lock
out the existing installation:

1. Create a **Managed** Turnstile widget in Cloudflare restricted to
   `dispatch.example.test`. Leave pre-clearance disabled; Dispatch verifies each
   protected submission directly.
2. Store its secret at `<secrets-root>/turnstile/secret-key`, owned by the dashboard
   service account, with directory mode `0700` and file mode `0600`. Symlinks and
   hard-linked secrets are rejected. Do not put the secret in environment variables,
   command arguments, frontend code, or Git.
3. Set `DISPATCH_TURNSTILE_SITE_KEY` to the widget's public site key in
   `<local-root>/config/dashboard.env` and restart through the normal deployment
   process. The public site key alone is returned in the session response.
4. Verify a real browser login and invitation registration on the canonical hostname,
   including retry after an incorrect password, then inspect Turnstile Analytics.

When the site-key setting is absent, the existing authentication flow is retained.
When present, startup rejects incomplete or invalid configuration, noncanonical
origins, and Cloudflare dummy keys. A missing, rejected, expired, or reused token
cannot create a session or account. Siteverify requests have an eight-second timeout;
transport errors fail closed with a retryable message. The form keeps entered values
and refreshes verification after a failed submission. Core backups and host recovery
include the private Turnstile secret and its directory ownership.

Only configured HTML responses allow the Turnstile script and iframe origin in CSP.
The widget script loads on authentication forms, not normal dashboard actions. Local
previews need no Cloudflare credentials. `tests/turnstile.test.js` exercises the real
verification adapter using simulated Siteverify responses; the isolated frontend
fixture's `DISPATCH_TURNSTILE_FIXTURE=1` option supports deterministic browser tests.
Those tests cover form behavior and enforcement, not Cloudflare's live bot detection.

References: [widgets](https://developers.cloudflare.com/turnstile/concepts/widget/),
[server verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

## Security boundary

- Every protected route requires an authenticated opaque session.
- DSP-owner and member routes contain no organization ID; the server derives the effective DSP from the active membership.
- Platform ownership does not automatically grant workforce access to every DSP.
- Organization switching submits a membership ID, and the server resolves that membership's organization.
- Every operational call reloads current session, membership, role, organization, and installation authority before using a local or gateway connector.
- Managed connector/socket selection is server-owned, and the gateway verifies its expected runtime identity on every call.
- Session cookies are `HttpOnly` and `SameSite=Strict`; session values are hashed at rest and never stored in browser storage.
- State-changing requests require JSON, the session's CSRF token, and a fixed route.
- Platform organization controls use opaque random references in JSON bodies rather than organization or invitation IDs in URLs. References are hash-only at rest, session-bound, expiring, and re-authorized per request.
- Platform organization creation, status/invitation changes, and provision/retry requests are idempotent. Invitation-path replays return no raw handoff.
- Sync additionally requires `--operator`, a ready installation, and `sync.run`.
- Passwords use versioned scrypt hashes; plaintext passwords and invitation/session tokens are not persisted.
- Provider credentials, Auth Broker vault contents, browser endpoints, and browser sessions are never exposed.
- Workforce data remains protected business data and must not enter general logs or public issue trackers.
- One exact Cloudflare Tunnel route is the public network boundary. The origin remains loopback-only; secure host-only cookies, exact Host/Origin/HTTPS checks, application throttling, managed WAF, and managed DDoS protection protect the public login/invitation surface. Bot Fight Mode remains off during testing because its zone-wide policy challenged scripted/headless acceptance. Authenticated transactional invitation email is enabled with Cloudflare Email Preview disabled. Administrator MFA/passkeys, reviewed bot controls, and final independent review remain hardening work. Password recovery has persistent per-email, per-IP, and installation-wide throttles shared by all dashboard processes using the access database.

See [Access Control](../core/accounts/OVERVIEW.md) for authorization and account storage.

## Verification

```sh
./core/accounts/scripts/verify
./runtime/gateway/scripts/verify
npm run build --prefix dashboard
npm test --prefix dashboard
```


### Hotfix builds

Published releases accept `X.Y.Z` and `X.Y.Z+hotfix.N`, where `N` is a positive integer without leading zeroes. For example, `0.0.7+hotfix.1` appears as **0.0.7 — Hotfix 1**. It is a separate GitHub tag and immutable release, with internal identity `dispatch_0.0.7_hotfix.1`. Existing tags and assets must never be replaced.

Dispatch explicitly orders release numbers and then hotfix revisions numerically; this is an application policy because SemVer ignores build metadata when comparing precedence. A later publication date cannot make the original build supersede its hotfix. Historical prerelease catalog entries retain their publication-date fallback. Core, DSP runtime, host control, recovery, and rollout records all use the distinct internal identity. Normal verified recovery and local package retention rules still apply.

Servers running the original 0.0.7 cannot parse hotfix catalogs. Their release discovery service and independent update supervisor must first be bootstrapped from the chosen merged hotfix source using the existing trusted release-delivery installation procedure. Queue the first hotfix rollout through that updated coordinator; subsequent hotfixes use the normal Updates flow. Verify the deployed source commit and run `core/installations/scripts/verify-live-dsps run` as root from the matching clean checkout to exercise the full live DSP lifecycle.
## Paycom workforce pages

Connected DSPs can use two Paycom tabs. **Timecard** defaults to today's date in the DSP timezone, shows employee names and the selected day's punches/hours/status, and supports prior-date selection. Every column toggles ascending/descending sorting across the full result before pagination; names default to A–Z and empty times/hours remain at the bottom. Multiple punches remain visible in source order, with sorting based on the first punch. The page refreshes today's collected data every 30 seconds without triggering a Paycom collection.

**Employees** searches the complete collected roster by name and opens an employee's profile and most recently collected period timecard inside that tab. Department, station, and position appear only in the employee detail. The original optional connection flow remains available to owners whose Paycom setup has not completed.

`GET /api/paycom/daily`, `GET /api/paycom/employees`, and `GET /api/paycom/employees/:code` require `workforce.read` and resolve the runtime from the authenticated DSP context. Historical days are available only for collected periods; unavailable dates are never presented as empty employee timecards. Employee detail uses the SDK's bounded daily projection rather than raw collector records.

Run the isolated workforce browser checks with `DISPATCH_PAYCOM_WORKFORCE_FIXTURE=1 DISPATCH_FRONTEND_PORT=4348 npm run test:ui -- tests/browser/paycom-workforce.spec.cjs`. The opt-in preview uses synthetic records through the real SDK and HTTP routes, including more than 100 employees to exercise sorting across pages.


## Password recovery

The sign-in form links to `/#/forgot-password`. Recovery reuses the configured
Cloudflare email account and private API token described above; there are no new
credentials or sender domains to configure. When delivery is not configured,
recovery fails closed with the same unavailable response for every address.
Turnstile, when enabled for the installation, also verifies the `forgot_password`
action on requests. The new-password form does not load a third-party widget.

- `POST /api/auth/forgot-password` accepts `{email, turnstileToken?}`. After
  validation and address/global throttling, it returns HTTP 202 with the same
  message for known, unknown, disabled, and email-throttled accounts. Account
  lookup and sending happen only after the response is written. Provider delivery
  failures do not change the response or disclose a reset link.
- `POST /api/auth/reset-password` accepts `{token, newPassword, confirmPassword}`.
  Reset tokens are 32 random bytes, stored only as SHA-256 hashes, valid for 30
  minutes, and bound to the account's credential version and email. Within one
  write transaction, a reset rechecks the token and account after scrypt hashing,
  replaces the password, invalidates every reset token, revokes every session,
  and records the completion audit event. It creates no login session.
- Email links use the canonical HTTPS origin and a URL fragment. The reset form
  removes the fragment token from browser history on mount and keeps it only in
  memory. Reloading requires reopening the email link. GET requests and email
  scanner visits never consume the token; only a successful reset POST does.
- Passwords retain the existing 12–128 character policy and scrypt hashing.
  A database trigger invalidates recovery links on credential-version, email,
  or account-status updates, including private administrator recovery. Recovery
  does not reactivate accounts, memberships, organizations, or change roles.
- Limits persist in SQLite: 5 email requests per address per hour, at least 60
  seconds apart; 20 requests per IP and 200 per installation per 15 minutes;
  30 reset submissions per IP and 100 per installation per 15 minutes. IPs and
  emails are hashed in the limiter table. Its 10,000-bucket bound fails closed
  instead of evicting active limits. Forwarded IPs are trusted only through the
  existing canonical public-origin/loopback Cloudflare boundary.
- Email work is bounded to 16 in-flight/queued jobs and password hashing to two
  recovery operations per process. The email worker keeps raw tokens only in
  memory: a process restart can discard unsent mail, so users may need to request
  a new link after the cooldown. Confirmation delivery is best effort and never
  rolls back a completed password reset. Delivery outcomes are audited without
  token, password, email body, or provider diagnostic logging.
- Schema 14 adds recovery-token and throttle tables. Sanitized Core backups remove
  both tables' contents, and managed restores never restore old reset tokens.

Security regression tests cover token replay, concurrent resets across database
connections, expiry/account changes during hashing, transaction rollback,
restart-persistent throttling, malformed/cross-site requests, delivery failure,
Turnstile action/replay checks, and browser recovery on desktop and mobile. The
browser fixture captures synthetic messages through private child-process IPC;
it does not expose an inbox endpoint or send real email.
