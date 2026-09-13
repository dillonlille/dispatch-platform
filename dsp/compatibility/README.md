# Compatibility code

The active local backend is `directory_service_v1`, implemented under `host/`.

`provisioner/` contains explicit older CLI compositions; they can load Core and
DSP code together and are excluded from runtime production artifacts. `paycom/`
contains thin executable aliases for retained artifact consumers. Current
collector registrations use `plugins/paycom/backend/bin/` after storage migration.
`cdf/` preserves the inactive historical implementation and its tests; Cortex's
current product scope remains sign-in and owner-entered email verification.

Do not activate older native/OCI provisioning commands to test the directory
backend. Before removing compatibility code, inspect imports, executable records,
artifact allowlists and backup/recovery consumers.
