# Temporary authentication workers

`AuthenticationWorker` opens only the supplied DSP vault, uses the selected
reviewed adapter and preserves existing persistent profiles and authentication
guards. It returns browser access, never credentials. Renewal and shutdown reuse
the current session manager; vault/maintenance locks remain held until browser
cleanup succeeds.

This is the worker implementation, not yet a process entrypoint or OS launcher.
Tests use disposable encrypted vaults and simulated browser processes. They do
not establish filesystem/process isolation. The host worker mount plan excludes
vaults from ordinary plugin workers and excludes plugin databases from auth
workers. The launcher and real isolation acceptance remain required before
provisioning can use these workers.
