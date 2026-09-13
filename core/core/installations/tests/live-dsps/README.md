# Live DSP lifecycle verification

Run from the clean source checkout matching the deployed native Core commit:

```sh
sudo ./core/installations/scripts/verify-live-dsps run
```

The command uses the existing Core service identity and a one-hour session for
an existing platform owner. It creates two clearly named `TEST … DSP …` tenants,
registers generated owners through private single-use invitations (no email),
and exercises the real provisioning, backup, suspend, restore, resume and removal
paths. Cleanup first removes each DSP through the API, then uses the protected local operator to permanently delete only fixtures created by that run. Browser password confirmation is covered by the dashboard and disposable lab tests. While waiting for operations, it also checks the real session and DSP listing APIs so database contention cannot silently leave the dashboard unavailable. It creates no VM and does not replace Core or reboot the host.

Synthetic provider publications are inserted only into the recorded test DSPs,
as their own Linux users in a temporary systemd namespace with networking disabled.
Provider schedules stay stopped. Activation uses explicit synthetic authentication
and publication receipts; this checks DSP lifecycle, not real provider login or
collection. The shared immutable runtime package is not modified.

The test requires the matching native Core release, connected encrypted backups,
a finished rollout, and automatic fleet backups disabled for the test window.
It does not change shared backup settings. Existing DSP identities and existing
verified archives are checked afterward. New Core archives containing test DSPs
would necessarily be deleted during test cleanup; historical Core backups proven
not to contain the test DSPs are preserved.

Progress streams one scenario at a time. Private state and a credential-free JSON
report live under `/var/lib/dispatch-live-tests/live_<random-id>/`. A failed run
leaves its DSPs available for diagnosis, prints its cleanup command and exits nonzero.
Cleanup only accepts identities recorded by that run and verifies their native
backend, generated owner address and test name; it does not accept arbitrary DSP IDs.

```sh
sudo ./core/installations/scripts/verify-live-dsps status live_<random-id>
sudo ./core/installations/scripts/verify-live-dsps cleanup live_<random-id>
```

The completed report remains after cleanup. Treat `state.json` as private: it can
contain generated test account credentials. The current owner session is revoked
when the command exits normally or handles SIGINT/SIGTERM. A forced kill leaves it to expire within one hour. An interrupted run can be cleaned up after its process exits.
