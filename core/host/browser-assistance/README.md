# Browser assistance

Paycom contributes CAPTCHA detection and verification after assistance. The DSP
auth broker retains exclusive ownership of the existing browser; the host runs
a fresh CAPTCHA-only Hermes conversation, then disconnects. The broker verifies
actual authenticated application access before granting a collector lease.
An agent's response text is never accepted as proof of authentication.

Verification starts on the original challenge page. If completing the CAPTCHA
leaves Continue pending, Paycom may click it once only when the document, numbered
fields, and retained PIN fingerprint match the pre-assistance state. It never
retypes PINs or submits a replacement/reloaded form. Application navigation waits
until that original-page check completes.

The directory controller creates `browser-assist.sock` in each DSP's private
control socket mount. Requests identify a temporary socket name and browser path,
never a DSP ID, filesystem root, model, command, or host URL. The controller-owned
socket binding supplies DSP identity. The host's temporary loopback WebSocket
requires an unguessable job capability. Completion, disconnect, cancellation, and
shutdown revoke established browser connections.

Configure the host in `local/config/browser-assistance.json` (mode 0600). Missing
configuration, or `enabled: false`, leaves assistance unavailable. Enabled version
1 accepts exactly `enabled`, `version`, `profileDirectory`, `hermesDirectory`,
`pythonExecutable`, `agentBrowserDirectory`, `concurrency`, and `maximum`. All
paths are private host paths outside source. The browser directory contains the
managed `agent-browser` executable; Python belongs to the installed Hermes
environment. The profile directory is under a standard Hermes `profiles/` root.
No machine paths or model credentials are bundled into the plugin.

Each job creates a disposable sibling profile with a fresh conversation ID and
no copied history or memory. This preserves Hermes's supported global model-auth
fallback. Only browser tools are exposed, with password-vault tools excluded.
Full browser controls serve the sole assigned task of completing the CAPTCHA.
The broker enters and scrubs provider credentials before assistance; credentials
never enter the agent prompt. The saved Hermes profile is not edited. Host model
credentials and temporary profiles are never mounted into DSP runtimes.

Normal and forced termination remove the disposable profile, private temporary
directory, and detached browser helpers. Startup reaps abandoned profiles using
recorded process identity. Sanitized last-attempt phase/timing goes in the DSP's
`state/plugins/paycom/browser-assistance.json`; no screenshots, agent text,
cookies, PINs, or tool arguments enter that receipt. Vaults stay in the DSP's
`data/auth-broker/`, keys in `secrets/auth-broker/`, and collected databases in
`data/db/paycom/`, outside `live/`. Build checks reject private state artifacts.

Defaults are one solver and four retained requests, with one FIFO position per
DSP, a 30-second queue deadline, and 200 seconds for solving. Existing collector
deadlines remain absolute. Cleanup retains the queue slot until helper shutdown.
Plugin disable, credential changes, runtime shutdown, and client cancellation
abort assistance. Failure preserves verification guards and returns verification
required without another credential submission. Enabling assistance never clears
an existing manual guard.

This handles CAPTCHA during authentication/application handoff. Mid-collection
CAPTCHA recovery for an already leased browser is not implemented. Queue limits
are resource controls, not measured 100-DSP capacity or universal CAPTCHA coverage.
Framework tests use local sockets and intercepted pages without provisioning DSPs.
Acceptance also checks the real DSP namespace transport, continuation, and cleanup.
