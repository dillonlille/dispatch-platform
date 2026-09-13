# Core browser manager

The independently supervised Core plugin backend owns browser admission through
`manager.js` and `store.js`. It starts DSP-scoped authentication workers through
`host/services/authentication-worker.js`; plugins use `dispatch-sdk` connection
sessions. Browser creation, owner login checks and collection share this budget.

The default single-host budget is two authentication workers, one per DSP, with
six page tabs per worker and twelve tabs overall. Admission is queued and bounded.
A lease occupies capacity until its worker cgroup is confirmed stopped. The
private SQLite ledger and exclusive kernel lock permit restart recovery before
new work is admitted. Idle workers exit; browser profiles remain in DSP storage.
The private CDP bridge enforces the page limit, including observed popup targets.

Normal plugins cannot launch Chrome, select host paths, access provider passwords,
or reach another DSP. A plugin receives a temporary job-scoped Unix browser
endpoint, renewed and released by the SDK. Plugins still own navigation and
collection code. Each process has separate filesystem, PID and network namespaces
and explicit CPU, memory and task limits. No per-DSP Linux accounts are created.

The daemon is launched by `host/services/plugin-backend.js`, independently of the
dashboard/controller. Stopping the dashboard does not stop the daemon. Core holds
references and policy; browser processes run in separate limited service cgroups.
These defaults bound resource consumption; they are not a fleet-capacity estimate
or a multi-host scheduler. See [runtime and migration](../../docs/plugin-runtime.md).
