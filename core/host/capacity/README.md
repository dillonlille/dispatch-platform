# DSP resource diagnostics

The owner-only `/api/platform/runtime` endpoint caches one fleet sample for two
seconds across dashboard clients. CPU is a monotonic cgroup CPU-time delta:
100% means one logical CPU core. The first sample after startup or a cgroup
restart has no CPU delta. Missing counters remain unavailable.

RAM, CPU and tasks include the DSP runtime plus isolated plugin and authentication
browser workers identified by Core's registries. Shared Core processes and shared
dashboard assets are excluded; worker memory is not compared to the runtime limit.

Storage scans run asynchronously when Diagnostics opens (`refreshStorage=1`).
Normal CPU/RAM polling only reads cached storage; elapsed time never starts a scan.
Concurrent opens share an in-flight scan. Reopening the page starts a fresh scan.
Visible pages renew owner-scoped viewer leases on their two-second polls. Leaving,
hiding or closing the page sends a CSRF-protected close request. Scans stop at the
next metadata checkpoint when the final viewer leaves; lost viewers expire after
seven seconds. CPU/RAM have no background timer, and storage never restarts from
ordinary polls. The browser stops its queries when hidden or unmounted. Scans
read file metadata and completed backup manifests, skip symlinks, and have a shared
entry/time budget. Managed volume usage comes from statfs; legacy layouts use
allocated file bytes. Runtime code outside the volume is reported separately.
Backup counts distinguish manual backups, DSP update snapshots and plugin rollback
copies. Backup bytes represent logical backup data, not additional volume usage
or a restore-integrity guarantee. Shared platform backup overhead is excluded.
Failed scans retain timestamped stale values, or report unavailable without a
prior successful sample. No host paths or runtime identifiers enter the response.
