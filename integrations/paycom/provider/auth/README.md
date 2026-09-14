# Archived Paycom authentication

`adapter.js` is the installed Paycom 0.18.5 `backend/authentication.js`, recovered
from the September 14, 2026 archive (runtime release
`fe91a2025e1300b5c31564b9b602e9456ece950a829bb377a43be3984a278463`).
Its only change is replacing the packaged SDK import with local `./cdp.js` imports.
`source-files.json` records the original file hashes. The provider adapter and
native Python input helper are checked against those hashes in the test suite.

The browser runtime, native display, CDP transports, durable attempt guard, and
sanitized authentication diagnostics are copied from that release's auth broker.
Imports point at these local modules. Storage and process identity helpers are
extracted from its vault and maintenance-lock modules; the old vault, registry,
account data, keys, and browser profiles are not part of this source import.

The shared platform wrapper lives in `integrations/paycom/authentication.ts`.
It maps the existing five-value credential array to `pin1` through `pin5`, retains
session-first authentication, upgrades to native input before submission, and
uses the archived guard for automatic acquisition and explicit owner checks.
Collection access requires the archived application-readiness and clean-tab
handoff checks. Failed connection checks replace the old dashboard state.

Infrastructure adaptations:

- TCP CDP stays inside each worker's private network namespace. The host/collector
  receives the existing private Unix socket relay, never an exposed browser port.
- The namespace proxy uses the archived loopback port 17891. Egress admits Paycom's
  domain and subdomains, as the archive did, while rejecting private destinations.
- The host validates root-owned Chrome, Xvfb, Python, and setpriv executables and
  their parents before launch. Inside the marked worker, the trusted-command helper
  accepts Linux's unmapped owner ID for those read-only mounts and the worker UID
  for namespace-created parent directories. Ordinary host checks still require
  UID 0; neither Chromium nor the outer sandbox is disabled.
- The dashboard opens an interactive window for user verification. Mouse, drag,
  wheel and keyboard input stay in that DSP's existing browser; only the explicit
  Submit action resumes authentication. The adapter independently verifies CAPTCHA
  completion and permits only its original-document continuation. There is no bot
  runner or external model access.

Authentication attempts, diagnostics, cookies, and native display state belong in
that DSP's private `state/browsers/paycom/authentication/` directory. Credentials
continue to use its encrypted vault in `secrets/`. Updating code does not import
any private archived state.
