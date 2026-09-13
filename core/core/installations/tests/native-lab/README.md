# Historical native DSP VM lab

This VM harness is no longer run by CI or the current testing workflow. Operational testing uses disposable test DSPs in the existing live setup. The instructions below document the historical isolated recovery drill; do not run it as part of normal verification, and never run its destructive recovery steps on the live host.

Run from a clean checkout:

```sh
./core/installations/scripts/verify-native-dsp-lab
```

This creates a disposable Ubuntu 24.04 VM, installs the current native Dispatch
code, exercises real dashboard HTTP APIs, the real reconciliation worker, fenced
root helpers, Linux accounts, systemd services and encrypted Restic repositories.
It destroys and restores the application host, reboots it, uses the real browser
UI, provisions another DSP, then permanently deletes the synthetic DSPs.

The runner needs Linux/KVM, QEMU, passwordless sudo, Node 22, Python 3.11+, patchelf,
Chrome, at least 15 GiB free storage and enough memory for a 4 GiB VM. Install the
dashboard's locked dependencies with `npm ci --prefix dashboard` and
its Playwright Chromium browser before running. The native package builder also
requires a clean Git checkout. `--package /path/to/package` reuses a previously
built native runtime package for debugging; use a fresh build for acceptance.

Production accounts, configuration, providers, email and backups are never
selected. Test invitations go to a private file inbox. Provider authentication
and initial-publication receipts are synthetic; provider stores, runtime health,
manual collection jobs and the tenant API are real. The offsite adapter runs real
encrypted Restic with separate local repositories. Actual Cloudflare transport,
retention locks, email delivery and third-party provider accounts require separate
integration checks; this lab does not report those as tested.

A JSON report is written to `/tmp/dispatch-native-dsp-lab-report.json`; override
with `--report`. A failure returns a nonzero exit status and preserves diagnostics.
The VM, temporary SSH key, runtime packages and all synthetic archives are removed
on exit. `--keep-on-failure` retains the stopped VM only when debugging a failure;
its directory contains synthetic secrets and must be deleted after investigation.
No account or Dispatch service is created on the runner host. Downloads use the
official Ubuntu image with its published SHA-256 checksum; SSH tunnels bind only
to loopback.

## Coverage

- Invitations, registration, duplicate create requests, native provisioning and owner details.
- Real native health, synthetic workforce publication, tenant API access and manual sync idempotency.
- Separate OS identities, peer-data and Core-secret denial, platform authorization and CSRF denial.
- Verified encrypted DSP backups, remote hydration, restore confirmation and wrong-tenant refusal.
- Restored data and session invalidation; peer data and service continuity.
- Suspension blocks existing sessions and new logins; resumption requires a new session.
- Full host recovery recreates code, accounts, secrets, data and services; metadata tampering and occupied destinations fail closed.
- Archive rediscovery after rollback, real reboot, then new provisioning using restored host permissions.
- Browser creation, fleet and backup pages, custom DSP roles, member invitation and revocation.
- Permanent deletion including individual and containing Core archives, exclusive users and pending invitations; deleted credentials and archive IDs cannot restore access.

Run `./tooling/verify` as well for the larger contract, failure, authorization,
provider-fixture, backup scheduling, rollout, compensation and retention suites.
`./runtime/tooling/verify` checks the native Chrome pipe and service sandbox.
The lab complements these tests; a passing report is not a claim of exhaustive
coverage of every possible state or live provider behavior.

## Live Cloudflare transport canary

On the configured VPS:

```sh
sudo node --no-warnings core/installations/tests/native-lab/live-r2.js --empty-bucket
```

This exercises the actual R2 credentials, encrypted upload, independent restore, recovery capsule
verification, archive deletion and restoration of retention locks. It refuses a
bucket containing existing managed archives, writes only synthetic data under a
new random archive ID, and deletes that archive and its local scratch directory.
It does not provision DSPs or send email. Run this separately from the VM suite;
CI uses the local encrypted storage adapter and has no production credentials.
