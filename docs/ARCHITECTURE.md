# Architecture

## Request flow

```mermaid
flowchart LR
    U[Dev user] --> C[Cloudflare Tunnel]
    C --> A[Independent Dev API and owner dashboard]
    A --> P[Dev account and membership database]
    A --> Q[Dev jobs and shared services]
    Q --> B[Private browser and collection workers]
    B --> S[Individual Dev DSP directories]
```

The API authorizes every request. Login creates a hashed, revocable server-side
session. A selected DSP receives a session-bound signed view token containing its
identity and authorization generation. Membership changes, DSP suspension and
settings revisions invalidate old views. The UI switches workspaces without
sharing employee caches between DSP components.

Platform owners can support all DSPs; opening a DSP records an audit event.
DSP owners manage memberships, settings and connections. Managers collect data.
Members read workforce data. An owner can belong to multiple DSPs and switch
between their authorized workspaces.

## Private state

```text
dispatch-platform/
  dev/live/                         Repository on dev; compiled runtime in .build/
  dev/config/                       Private environment/tunnel configuration
  dev/data/platform/                Accounts, memberships, audit, keys, update receipts
  dev/data/preview/                 Dev jobs and worker runs
  dev/dsps/dsp_<random-id>/
    config/                         DSP configuration files
    data/dispatch.sqlite            Connection/schedule settings and workforce
    secrets/vault.key               Per-DSP credential encryption key
    secrets/paycom.enc               DSP-bound encrypted provider credentials
    state/browsers/paycom/           Persistent private provider browser profile
  archive/                          Retained previous workspace
```

The future Production environment uses the same layout under `public/`, with no
shared private state. `live/` contains code only. Account identities have separate
first and last names; there is no display-name field.

DSP directories contain no executables, dashboard copies, plugin installations,
package managers, or service definitions. DSP creation inserts a provisioning
record, creates private directories and schemas, and activates the DSP. A failed
provision can be retried. Browser binaries and provider logic are shared.

## Collection

1. An authorized user or daily scheduler creates an idempotent durable job with
   the DSP ID, initiating actor, environment and credential generation.
2. A bounded worker pool claims jobs fairly and permits one active job per DSP.
3. The auth broker reads that DSP’s credentials and opens only its provider
   profile. Challenges pause the job for an authorized owner to complete.
4. A collection worker in a separate process/filesystem/network namespace gets
   a private connection to that browser. It cannot open the profile, vault, host
   home, platform database, or another DSP’s browser.
5. The worker reads the provider’s employee roster and current pay-period data.
   The adapter validates identity, dates and response completeness. The database
   switches its active publication only after the complete result validates.
6. Jobs retain status, progress, attempts and an audit trail. Cancellation,
   suspension or changed credentials prevent the job from publishing. Crashed
   leases recover; eligible transient failures retry with backoff.

Default capacity is two browser sessions per environment. Verification expires
after ten minutes; native collection has a thirty-minute deadline. A ready
connection indicates the last successful verification, not a permanently running
browser. Profile cookies are restored on the next temporary session.

## Dev builds and releases

The permanent Dev DSP and all test DSPs belong to the independent Dev platform.
It owns its login, account schema, owner dashboard, jobs and provider sessions.
`DISPATCH_STANDALONE=1` disables the older gateway and in-dashboard activation flow.
The older code remains exercised by isolated compatibility tests only.

Feature PRs merge into `dev` on the owner's instruction. Successful push checks
upload one verified build; the Dev timer installs only the current merged commit's
artifact. The runtime and checkout update together, with health verification,
code rollback and interrupted-update recovery. Private state is never replaced.

The owner requests a release after testing. The final versioned candidate is
verified, its source merges into `main`, and its exact artifact is published.
Production publication/deployment automation is deferred to the Production setup.
