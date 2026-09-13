# Core plugin services

`sdk-service.js` binds each transport to a host-authenticated DSP, plugin,
installation revision and job. It validates closed SDK messages, checks authority
before and after asynchronous work, and releases browsers acquired during
revocation. Ordinary SDK requests cannot choose their own identity.

`access-authority.js` checks the existing Core access database on every request.
Connections require both a manifest declaration and an explicit connection policy
grant. Missing grant policy denies connection access. Individual handlers must
also enforce ownership of job, schedule and published resources.

`package-catalog.js` reads the host-managed approved package digest allowlist from
`local/config/plugin-packages.json`. Packages reside under
`local/packages/plugins/<plugin-id>/<version>/`. No request supplies a package
path or digest. `installation.js` orders the catalog and host lifecycle ports.
Core accounts retains the durable desired/applied installation registry and now
accepts this coordinator during reconciliation.

The directory API enables the coordinator with the scoped worker launcher,
initialization hooks and independently built packages. `runtime-services.js`
adapts jobs, schedules, publication and structured logging to existing durable
DSP services. Worker execution remains bounded by global and per-DSP admission.
The dashboard's split mode forwards HTTP requests to `core/api/`; private worker
SDK traffic continues using bound Unix sockets.
