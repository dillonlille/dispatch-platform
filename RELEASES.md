# Builds, release review and future operation

**This rebuild does not authorize live setup.** The commands below document the
operator tooling for a later approved setup. Builds, imports and plans alone do
not start services. There is no publishing or installation on Git merge.

## Build and inspect

```bash
npm run build
npm run dispatch -- release-import /absolute/path/to/artifact "Release notes"
npm run dispatch -- release-plan DIGEST preview
```

Set `DISPATCH_STATE_ROOT` to a disposable development root while reviewing these
commands. `.build/release.json` contains the version, compatibility schema, Node
major, every runtime file hash/size and the aggregate immutable digest. Verification
rejects missing, changed, extra, duplicate, traversing, symlink or hard-linked files.
An import retains its own verified copy so editing the build directory cannot
change a previously imported release.

## Later first setup

The future state root is `/home/thepickle/dispatch-platform`; built code is placed
directly there. It must have private permissions. Configure Node, a compatible
Chromium/bubblewrap host, canonical HTTPS origin and SMTP separately.

1. Set `DISPATCH_STATE_ROOT`, `NODE_ENV=production`, `DISPATCH_PROVIDER_MODE=native`
   and `DISPATCH_ORIGIN=https://your-dashboard-host`.
2. Bootstrap the owner with `dispatch bootstrap EMAIL NAME`, supplying the password
   on stdin, not a command-line argument. This creates the permanent Dev DSP.
3. After explicit setup approval, set `DISPATCH_ENABLE_DEPLOYMENT=1` and use
   `dispatch initialize ARTIFACT OWNER_EMAIL`. It installs an initial baseline
   into both runtime locations while the fleet is empty. It starts nothing.
4. Run the built `tooling/supervisor.js` under the approved process manager. The
   supervisor starts the two API processes, gives the gateway a private Preview
   signing key, and processes approved release requests.
5. Verify Dev authentication, workforce, native browser isolation and provider
   collection before adding production DSPs. This host’s inner Chromium sandbox
   compatibility remains an explicit acceptance item.

No systemd unit, proxy configuration, SMTP credentials, DNS record or live state
is installed by repository scripts. The first-install command refuses an existing
deployment or a fleet containing production DSPs.

## Subsequent release flow

1. Build once and finish repository checks. Import the verified artifact.
2. Click **Update Dev** on Releases. Only Preview restarts with the candidate.
3. Test the permanent Dev DSP, then click **Mark tested** on the current candidate.
4. Click **Promote**. Only that exact tested digest can become Production.

The supervisor stops the target API, allows graceful worker shutdown, replaces
only its managed code directories, starts the selected artifact and checks its
reported digest. A failed health check restores the previous code and restarts it.
Production activation affects all production DSPs and causes a short maintenance
window. DSP data, credentials, profiles, central state, `dev/` and `archive/` are
outside the replacement list. An update never copies credentials from Dev.

The managed list is `dashboard`, `api`, `services`, `integrations`, `shared`,
`tooling`, `node_modules`, `package.json`, `package-lock.json` and `release.json`.
Only entries present in an artifact are installed. Source modules may be bundled
into the API or worker entrypoints rather than copied as separate runtime trees.

## Interrupted activation

Activation writes its intent receipt before the first directory rename. If the
supervisor crashes during an activation, it refuses to restart an ambiguous
running request automatically. With supervisor and both APIs stopped, inspect
`local/platform/activation-backups/*/receipt.json` and the pending request. Recover
with `dispatch release-recover RECEIPT_DIRECTORY REQUEST_ID` and the explicit
deployment switch. It checks the request/receipt match, restores code from the
recorded moves, and marks that request failed. Then restart the supervisor.

Code rollback does not undo data migrations. This baseline uses schema version 1;
future schema changes must retain rollback compatibility or provide an explicit
offline migration/recovery plan before promotion.

## Backup and restore

```text
dispatch backup /absolute/private/backup-destination
dispatch restore /absolute/private/backup /absolute/empty/restore-target
```

Stop services before backup. The command takes API locks so they cannot start
during the snapshot. Restore verifies checksums, clears old authentication tokens,
cancels pending jobs and clears release paths. Reimport an artifact and complete
the later host setup before restarting a restored platform.
