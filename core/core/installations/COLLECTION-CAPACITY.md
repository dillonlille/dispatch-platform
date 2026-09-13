# Collection capacity and staged verification

Every native DSP retains its own account, credentials, browser profile, database,
collection locks and runtime. Core coordinates scheduling metadata only: an opaque
job ID and a requested worker count. No Paycom credentials or collected records
enter the capacity queue.

## Capacity control

Native Paycom jobs acquire a grant through their local Runtime Agent status socket
and existing authenticated agent bridge before launching a collector. Core allows
one active grant and one queue position per DSP. FIFO ordering prevents a DSP
from repeatedly jumping ahead of waiting DSPs. A grant can reduce the requested
Paycom timecard concurrency (1–6) to the available worker budget. It never increases
it. Each DSP can use at most half the total budget (rounded up), leaving room
for another DSP when the budget is greater than one. Authentication/setup outside collection jobs is not governed by this budget.

The automatic initial worker ceiling is the minimum of four, half the available
CPUs (rounded down), and one worker per GiB after reserving 2 GiB for Core and the
OS, with a minimum of one. This is a conservative starting configuration, not a
measured throughput guarantee. Set `DISPATCH_COLLECTION_WORKER_LIMIT` (integer
1–64) in the Core service environment after measuring the host. Invalid overrides
prevent Core from starting. Per-DSP systemd CPU/memory limits remain in effect.

Clients poll while waiting and renew active grants every ten seconds. Grants and
abandoned queue entries expire after two minutes. A failed renewal cancels the
collector; ordinary release waits for child termination. Disconnects retain active
grants until expiry. After Core restarts, a two-minute recovery interval allows
surviving clients to stop before any new grants are issued. Capacity errors never
fall back to uncoordinated collection. During a mixed-version rollout only upgraded
DSPs participate in this budget.

The existing 15-minute Paycom interval and up-to-60-second variation remain. The
variation now includes the DSP runtime identity, spreading otherwise identical
schedules. Explicit manual sync requests remain immediate requests to the queue.
The Paycom page displays waiting, collecting, retry, paused and authentication
states plus the last successful sync time. Waiting for capacity is not a collector
execution timeout and does not produce a false overdue-run alert.

## Measure before tuning

Run the bounded local browser probe from a trusted checkout on the host to size:

```sh
./runtime/supervisor/scripts/measure-collection-capacity --dsps 1,2 --workers 2 --seconds 5
```

It launches separate temporary browser profiles and private pipes, generates and
reads synthetic tables, and removes its processes and files afterward. It does
not use Paycom credentials, contact Paycom, or touch DSP data. JSON reports startup
latency, operation P50/P95, failures, aggregate browser RSS, minimum host free memory
and host CPU utilization. RSS sums include shared pages; host measurements can
include unrelated load. These results measure local browser capacity only. Measure
representative live collection duration/failures on designated test DSPs before
raising the production limit. Repeat with increasing DSP counts while retaining
headroom for Core, backups and authentication.

## Verify a test DSP before the fleet

For a user-requested release, add `--canary-organization ORGANIZATION_ID` to the
existing `dispatch-access-admin rollout-start` command. Choose an explicitly
identified disposable test DSP that is active, native, ready, connected to Paycom,
and has its workforce sync running. This option does not create a DSP or enable
its sync. The selected DSP is persisted at the front of the rollout; the existing
Core backup/update/verification stages still run first.

After that DSP's normal lifecycle upgrade verifies its runtime and publication,
Core requests a fresh, idempotent workforce sync and requires a successful
collection after the verification start plus healthy collection storage. Other
DSPs remain queued until this check passes. Success is recorded durably in the
existing audit store and survives Core restarts. Failure, unavailable verification,
or a 30-minute timeout pauses the rollout; resolve the test DSP and use the existing
resume command to retry. Removing the selected test DSP blocks the gate. Rollouts
without a selected test DSP retain the existing sequential verification behavior.

Adding this capability does not authorize a production rollout. Release version,
publication and rollout remain user initiated.
