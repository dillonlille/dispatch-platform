# Core auth broker

`server.js` runs the supervised Core plugin backend. `coordinator.js` owns DSP
worker admission, connection authorization, package generations and temporary
browser sessions. `service.js` remains the small injectable SDK facade.

Credentials retain the existing encrypted DSP vault and key format. The vault,
key, profiles and attempt guards remain below `dsps/<id>/`; no credential database
is created in Core. `runtime/workers/authentication-server.js` mounts only the
selected DSP's auth storage and approved installed login adapters. Ordinary
plugin workers receive authenticated browser access without vault access. Auth
workers cannot read the DSP's business databases or agent registration token.
The privileged host controller remains a trusted platform authority.

Owner Settings, connection tests and signed platform-owner DSP views use the
same connection administration protocol through the SDK framework transport.
Each request revalidates Core DSP authority. Plugin connection grants additionally
pin the DSP's acknowledged package digest and revision; declaring a service in a
manifest does not grant it automatically. Core may relay owner credentials in
memory to that DSP's worker, but does not persist them or log them.

When another DSP is queued, idle authentication workers yield their slots even
if status polling keeps them warm. Active requests, provider verification and
plugin browser leases retain their workers. Directory DSPs enroll Paycom through
the vault worker without waking the full collection runtime; subsequent setup
waits in its existing onboarding queue when runtime capacity is occupied.

The existing provider session, attempt-guard, native Chrome and assistance code
is reused. Paycom's adapter comes from the DSP's installed package. Cortex stays
a built-in automatic sign-in and owner-entered email-code connection. A plugin
update does not interrupt an in-progress Cortex verification: metadata and its
verification code retain the existing worker, and new logins wait for an idle
worker before switching package generations. There are no Cortex collectors.

Disabling a plugin revokes its jobs and sessions; DSP suspension revokes all of
that DSP's workers. Credentials, guards and saved profiles survive installs,
upgrades and uninstall. Credential removal remains a separate owner operation.
See [runtime and migration](../../docs/plugin-runtime.md).
