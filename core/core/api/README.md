# Dispatch API

`dispatch-api` is the authenticated HTTP service. It owns backend composition,
account/session authorization and DSP coordination. It does not serve dashboard
HTML, and plugin code still executes in DSP workers. The browser manager and auth
broker remain separately supervised Core services; credentials, settings and
business databases remain in their DSP directories.

From the editable source, the split directory deployment runs:

```sh
bin/dispatch-api --installation-backend directory_service_v1 --installation-operator --operator --port 4311
bin/dispatch-dashboard --api-origin http://127.0.0.1:4311 --port 4310
```

Only the API receives `DISPATCH_PLATFORM_CONFIG`. Configure the same canonical
public origin on both services behind the existing reviewed HTTPS proxy. The API
loads its origin from private dashboard settings in directory mode; give the UI
`--public-origin https://dispatch.example.test`. Cookies and browser requests keep
the existing origin and `/api/` paths. The UI forwards cookies, CSRF, signed DSP
views and the original Host without constructing a new identity. It streams a
request once and never automatically retries a mutation. Worker SDK sockets and
local database access remain private and do not make HTTP round trips.

`host/services/api-units.js` renders `dispatch-api.service` and the existing
`dispatch-platform-local.service` (now the UI). `prepare-startup` prepares both
units for a reviewed migration. It does not activate them. Do not run the legacy
combined controller and the new API against the same platform simultaneously.

## Source ownership

- `server.js`: API routing and request policy, with no static-asset dependency.
- `access-http.js`: account, connection, installation and settings endpoints.
- `plugin-operations.js`: automatic manifest-based operation routing, validation,
  audit attribution and authorization checks before and after asynchronous work.
- `http.js`: existing request parsing, safe response helpers and protocol policy.
- `directory-platform.js`: directory backend startup and orderly shutdown.
- `main.js`: standalone API command and retained native/OCI startup support.
- `dashboard/server/shell.js`: static UI and bounded-loopback API forwarding.

The old dashboard module paths are compatibility imports. Starting
`dispatch-dashboard` without `--api-origin` deliberately retains the combined
launcher for existing installations and legacy artifact/recovery consumers.
The new split unit uses `--api-origin` explicitly; the dashboard does not open a
store, start a controller or inherit backend configuration in that mode.
`GET /api/health` checks API database access and returns a minimal service-ready
response. It does not claim that every provider connection or DSP job is healthy.

## Adding an operation

Declare an action in a plugin's `dispatch-plugin.json`, including its permission
and input/output schemas. It is available at
`POST /api/plugins/<plugin>/<action>`. DSP identity comes from the authenticated
session or signed owner support view, never a body field. A declaration requests
a permission; it does not create a grant. Existing platform roles continue to
control access.

An optional `errors` list declares public business error codes. A handler can
throw a matching SDK `DispatchError`; `definePlugin` converts it into the standard
failure result. Undeclared implementation failures remain inside the worker's
normal error boundary. The same error declarations appear in generated docs.

`dispatch-sdk/operations` validates the definitions and builds convenient clients.
`dispatch-sdk/plugin` wraps worker handlers with the same input/output validation.
The worker host also validates declared contracts independently. Generated
OpenAPI descriptions and TypeScript clients come from those declarations; run
`bin/dispatch plugin generate <plugin>` after editing one. Packaging checks for
stale generated contracts.

This first contract pass covers plugin actions. Existing accounts/settings API
contracts retain their current validators. Paycom action inputs are declared;
its complex result models continue using the workforce contracts. New generated
plugins include explicit input and output schemas. Existing plugin HTTP routes
remain compatible while consumers can adopt the generated action clients.

The supported schema subset is deliberately closed: objects with explicit
properties/required fields, arrays, strings, numbers, integers, booleans, null,
primitive enums, and bounds. It uses standard JSON Schema keywords and rejects
unsupported keywords rather than silently ignoring validation requirements.
