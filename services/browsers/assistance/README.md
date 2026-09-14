# Optional archived CAPTCHA assistance

The vendor runner, Python session, queue, and capability-protected browser relay
come from the archived platform. `vendor/source-files.json` records source hashes;
imports now use extracted local storage/path helpers. DSP IDs use the rebuild's
32-hex format. The shared host coordinates one queue across all DSPs.

Enable only through the environment's private `config/browser-assistance.json`,
mode 0600. Missing configuration or `enabled: false` leaves the dashboard's manual
verification available. This repository does not provision Hermes, copy private
model credentials, or enable the helper during a code update.

Version 1 configuration has exactly these fields:

```json
{
  "version": 1,
  "enabled": true,
  "profileDirectory": "/private/hermes/profiles/paycom-assistance",
  "hermesDirectory": "/private/hermes/source",
  "pythonExecutable": "/private/hermes/venv/bin/python3",
  "agentBrowserDirectory": "/private/browser-tools/bin",
  "concurrency": 1,
  "maximum": 4
}
```

Paths must be outside the installed artifact/source. The profile and its config,
`.env`, and authentication files must be private to the platform service user.
The configured profile is unchanged: each task gets a disposable sibling profile,
a fresh conversation, and only browser tools. Model credentials stay on the host;
DSP workers never receive them. The helper's only task is the existing CAPTCHA.

The archive's queue allows one FIFO position per DSP, with a 30-second queue limit
and 200-second solve budget. Credential replacement, disconnect, DSP removal, and
platform shutdown cancel assistance and remove disposable state. Startup's first
assistance request reaps abandoned tasks using PID/start-time identity. A failed
solver leaves verification to the owner and does not resubmit credentials.

The dashboard can show verification while a configured helper is running. Manual
input and another connection check wait until that task finishes. Collection
handoff can wait for one assistance attempt, then rechecks Paycom application
access. An already-running collection is not automatically recovered after a
mid-collection CAPTCHA, matching the archived limitation.

Tests use intercepted pages and a deterministic local solver. They validate native
PIN entry, the private relay, original-page continuation, queue bounds, and helper
cancellation without sending credentials or data to Paycom or a model service.
