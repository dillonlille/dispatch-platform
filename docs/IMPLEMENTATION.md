# Rebuild implementation record

This repository replaces the per-DSP installation model with shared application services.
The source repository is `dev/` directly. Production application directories will be
siblings of `dev/`; `preview/` will contain the candidate deployment. DSP state stays
in `dsps/` and central private state in `local/`. No deployment is authorized by this task.

## Completion checklist

- [x] Typed contracts, safe storage, schema migrations, encrypted secrets
- [x] Accounts, sessions, invitations, recovery, roles, server-verified DSP views
- [x] DSP provisioning, memberships, suspension, audit, settings
- [x] Durable jobs, retries, cancellation, recovery, fair capacity, schedules
- [x] Browser leases, per-connection profiles, native worker boundary, private egress
- [x] Provider adapter and validated publication; real-account acceptance deferred
- [x] Shared dashboard with operational flows and responsive layouts
- [x] Preview routing, immutable release inventory, verification and promotion tooling
- [x] Consistent backup/restore and operational CLI
- [x] Security, integration, native-fixture, UI and artifact verification
- [x] Source review and repository handoff preparation; no production activation

## Design

Reference: `docs/design/platform.png`. White content, deep forest sidebar, emerald
actions, restrained pale-gray summaries, table-first layouts and 8px corners.
There is no Plugins page in this rebuild, per the user’s instruction. Integrations
are enabled through each DSP’s Connections page.
Primary navigation: DSPs, Jobs, Releases, Audit log, Settings. DSP view: Overview,
Employees, Timecards, Connections, Jobs, Settings. Forms use actual provider fields:
client code, username and password. The concept's invented API-key fields and
decorative modal inset are not implementation requirements. Runtime values come
from the API, with clearly marked synthetic fixtures only in development.

## Verification boundary

All development state and verification artifacts use an explicit synthetic directory
outside the repository. No archived credentials or production DSP data are used.
Native Paycom behavior is implemented against the prior public provider contracts
and synthetic fixtures; real-provider acceptance is deferred to an authorized
deployment/connection test. Existing unrelated host services stay untouched.
