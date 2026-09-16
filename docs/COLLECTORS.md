# Collector storage and extension contract

Each DSP owns its collected data. Providers share application code and execution
services, but never databases, credentials, or browser profiles between DSPs.

## Storage ownership

```text
dsps/dsp_<id>/
  data/
    dispatch.sqlite                 DSP profile and storage-layout metadata
    paycom/
      paycom.sqlite                 Paycom connection, settings, schedule and data
  secrets/
    vault.key                       Existing per-DSP encryption key
    paycom.enc                      DSP/provider-bound Paycom credentials
  state/browsers/
    paycom-browseros/                Persistent Paycom browser profile
    paycom-attempt.json              Authentication cooldown/recovery state
    paycom-diagnostics.json          Restricted structured driver diagnostics
  config/                           Reserved DSP configuration files
```

SQLite owns the `-wal` and `-shm` files next to each database. Keep a provider's
related tables in one database so validation and publication are one transaction.
There are no raw provider-response archives or exports by default. Introduce a
provider-local export directory only when a feature defines its permissions,
retention and backup requirements.

`dispatch.sqlite` owns DSP-wide settings such as `dsp.profile`. Paycom owns its
`settings` (including preference history and sync interval), `connections`,
`schedules`, `publications`, `employees` and `timecards` tables. Its internal
`storage_identity` table binds the file to the DSP and provider. Account identity,
membership, the DSP registry, audit and the durable job queue remain in the shared
platform databases. Provider enablement is in the provider's connection record;
there is no duplicated enablement flag in the DSP core.

The shared process calls `Store::dsp(id)` only for DSP-wide settings and
`Store::collector(id, Provider::Paycom)` for Paycom data. Only compiled provider
identifiers can select paths. The cache is bounded across both core and provider
databases and keyed by the full database path. Each collector defines its own
schema and SQLite version; opening an unsupported version fails closed.

## Migration and rollback

The rollout uses two deployments. The dual-layout reader was introduced in
`9a63ef1` (PR #29) with automatic migration disabled. The following deployment
enables migration, after the compatible reader is verified in Dev. The previous
artifact can read and write migrated state if activation fails. Do not roll back
to a build predating `9a63ef1`. Migration is now enabled for startup/provisioning.
Normal updater rollback retains the immediately previous compatible artifact.

Migration runs under the exclusive platform process lock, before serving traffic
or running the scheduler. Active and suspended DSPs migrate at startup. New and
retried DSP provisions use the same path before activation.

1. Keep the original `dispatch.sqlite` authoritative. Create/validate the private
   `data/paycom/paycom.sqlite` with the provider schema and DSP identity.
2. Copy every Paycom table and `paycom.*` setting in a destination transaction.
   Check foreign keys and compare all business-table rows before committing.
3. In a separate atomic source transaction, remove Paycom tables/settings and
   commit `settings['storage.collectors'] = 1`. DSP profile settings remain.
4. All readers use the marker, never provider-file existence, to select storage.

A crash before step 3 leaves the original authoritative. Retrying copies its
current contents again, including changes made during a rollback. A crash after
step 3 uses the completed provider database. Missing or mismatched provider files
fail closed; they are never silently replaced with an empty database. This is a
copy-then-cutover protocol, not an assumed atomic transaction across WAL databases.
Do not run migration through a request or while database workers are serving.

The offline backup command already recursively snapshots every `.sqlite` file in
`data/` and `dsps/`, and includes DSP secrets and browser state. It therefore
captures both layouts and nested provider databases. Restore verifies checksums,
revokes sessions and cancels pending jobs. Restored legacy backups migrate on
startup once migration is enabled. Configuration remains separately backed up.

## Adding a collector

A new integration requires code, tests and a deployment; it is not an arbitrary
path or executable supplied by a DSP.

1. Add a compiled `Provider` variant with a stable lowercase ID, job kind,
   provider-owned schema and explicit schema version. Reserve
   `data/<provider>/<provider>.sqlite`. Define DSP-bound storage identity and
   initialization/migration before permitting reads. Provision only collectors
   that the product makes available to that DSP.
2. Add provider-specific credential validation and encrypted secret storage,
   using a DSP/provider/version binding. Give its browser a separate profile
   under `state/`; never reuse another provider's session.
3. Define the adapter's result contract and validate identities, completeness,
   ranges and dates before publishing. Commit the complete dataset and active
   publication together; failure must preserve the last successful dataset.
4. Register its job kind and implement explicit execution dispatch. The job queue
   remains shared with provider-qualified kinds, authorization rechecks,
   idempotency, cancellation, bounded capacity and per-DSP fairness. Unknown kinds
   are rejected. Today execution and scheduling support Paycom only; registering
   a storage variant alone does not enable a new collector.
5. Add authorized API routes and reads using the typed collector accessor. Keep
   provider settings/schedules with the provider data. Review timezone updates,
   suspension and credential-revision cancellation across all affected collectors.
6. Test provisioning, failed/restarted migration, schema compatibility,
   cross-DSP isolation, failed publication, scheduler behavior, backup/restore
   and the previous supported artifact. Update the architecture and operations
   documentation with any new retention or recovery requirements.

Provider employee IDs remain provider-owned. If future products need unified
employees across providers, introduce explicit DSP-wide identities and mappings;
do not merge people by name or assume provider IDs mean the same thing.
