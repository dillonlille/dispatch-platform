# Building a Dispatch plugin

The developer writes plugin behavior and declarations. Dispatch supplies HTTP
routing, authorization, settings, worker storage, shared UI and packaging.

From the editable source root:

```sh
bin/dispatch create plugin example-workspace
bin/dispatch plugin generate example-workspace
bin/dispatch plugin check example-workspace
bin/dispatch plugin dev example-workspace
```

The generator refuses to overwrite an existing directory. It creates:

```text
plugins/example-workspace/
  dispatch-plugin.json       Pages, operations, permissions and settings
  backend/index.js           Business handlers and database initialization
  frontend/index.tsx         Page using shared SDK controls
  generated/client.js        Validated operation client
  generated/client.d.ts      Typed inputs and results
  generated/openapi.json     HTTP operation documentation
  README.md
```

The starter implements paginated entries and an Allow new entries setting. Its
SQLite database belongs to the invoking DSP. Submissions use an idempotency key;
repeating a request returns the same record, and reusing its key for different
content is rejected. The SDK UI supplies the authenticated request transport and
the shared settings form. The page resets its draft when DSP authority changes.

The initial template uses the existing `dashboard.view` read permission and
`organization.settings.manage` mutation permission. Select appropriate existing
permissions when adapting it. It does not automatically grant newly invented
permission names or change platform roles.

The example at `sdk/examples/example-notes/` is an executable reference and is
excluded from the production plugin catalog. Use its path instead of a plugin ID
with `plugin dev`, `plugin check` or `plugin generate` to try it directly.

## Development workspace

`plugin dev` builds the same sealed package format used for installation, creates
a fresh workspace under `dev/build/`, and starts an API plus a separate dashboard
process. It prints the local URL and two synthetic DSP owner accounts. Each DSP
has separate settings/history and SQLite files. Original application source,
live accounts, provider credentials and production services are not used.

The runner uses the actual account, authorization, settings and generic operation
HTTP implementations. Business handlers use the packaged SDK and local storage.
Connections are disconnected fixtures, and browser automation/collection jobs
are not started. Use `dispatch-sdk/testing` for additional fake service responses
and native acceptance tests for production worker isolation. This runner executes
trusted development code and is not a security sandbox for untrusted plugins.

Restart `plugin dev` after changing code; each invocation creates a fresh workspace
and rebuilds the package. Existing workspaces remain available for inspection.
Stop the command with Ctrl-C to stop its API and dashboard. The check command
validates generated contracts and builds a sealed package without starting it.

## Packaging and delivery

The manifest's `package` section declares the installed runtime, optional login
adapter and optional collection specification. A plugin without authentication
or collection work can leave those two entries null. The builder embeds an
independent SDK copy and rejects imports outside the plugin/approved SDK boundary.

Keep lengthy operations in the existing durable jobs and DSP worker framework.
Local storage stays local through the SDK. Credentials stay in the DSP vault and
plugins request authenticated sessions through Core's broker.

Production delivery still uses the approved package catalog and installation
lifecycle. Every installed DSP receives the approved latest version automatically;
settings/data migrations and rollback snapshots preserve that DSP's state. The
development runner does not publish packages or change the fleet's versions.
