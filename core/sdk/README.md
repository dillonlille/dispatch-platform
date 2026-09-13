# Dispatch SDK

`dispatch-sdk` is the plugin client library. It has no dependency on Core,
runtime source, or any provider package. The host injects a transport already
bound to the plugin's authenticated DSP/job context. Services enforce that scope
independently of the SDK. No password, vault key, or arbitrary DSP path is part
of the plugin client API.

```js
const { createDispatchClient } = require('dispatch-sdk');
const dispatch = createDispatchClient({ transport: authorizedPluginTransport });
await dispatch.connections.withSession({ connection: 'paycom' }, async session => {
  await collectWithBrowser(session);
});
```

The callback receives sensitive authenticated browser access and a cancellation
signal. Honor the signal and never log browser endpoints or authentication state.
Leases renew during use and release on success or failure. Server-side expiry
and worker termination remain necessary if a process crashes or ignores aborts.

The Node client exposes settings, connections, jobs, schedules, actions, published reads,
progress, logs and capability negotiation. An isolated host may inject local
storage handles. The `dispatch-sdk/browser` client exposes dashboard action and
status and owner settings requests; the shell supplies its authenticated HTTP/CSRF transport.
`dispatch-sdk/testing` provides fake transports for offline tests.

`dispatch-sdk/node` provides the private Unix transport. `dispatch-sdk/node/cdp`
contains the existing browser protocol client for navigation/extraction, including
the private Chromium pipe transport. Browser creation and the pipe server remain
owned by authentication workers. The old runtime CDP imports forward to this
client, and Paycom's browser implementation now imports the SDK client directly.

API version mismatches fail explicitly. Transport errors are bounded; operations
are never automatically replayed. Mutations that support retries require an
idempotency key. A client method does not imply a grant: unsupported or denied
operations are rejected by the service.

`dispatch-sdk/runtime` is the trusted DSP framework bridge to Core plugin and
auth services. Its socket is absent from ordinary plugin namespaces. Existing
`runtime/sdk` clients retain response compatibility and route through that bridge
when the directory supervisor sets `DISPATCH_PLUGIN_BACKEND=core_v1`.

Worker entrypoints receive an injected client, or can use
`createWorkerClient()` from `dispatch-sdk/node` at the fixed namespace paths.
`storage.database(name)` opens a plugin-owned SQLite database;
`storage.files(collection)` provides bounded atomic file writes and reads.
`storage.directory(kind)` exposes only the plugin's mounted database, files,
state, staging or published directory. None of these methods accepts a DSP ID.

`schedules.status(id)` returns the existing sync status and Core business timezone;
`schedules.run(id, options)` uses the existing durable collection scheduler.
`jobs.enqueue` accepts a declared plan ID and an idempotency key. Cancel/retry and
schedule mutations preserve idempotency receipts in the DSP's collection database.
Progress accepts structured phase/count fields; logs accept safe codes and counts,
without raw free-text provider messages.

The frontend uses `dispatch-sdk/ui` for the shell's authenticated request helpers,
session, timezone and UI components. The installed bundle registers with the
shell's versioned host. This interface preserves owner/support-view scope and
CSRF protection; it is not a JavaScript security sandbox.

Build the SDK with `npm pack` in this directory. The installed-plugin builder
embeds an independent SDK copy in each package; no published npm service or
shared executable plugin directory is required. See
[package delivery and migration](../docs/plugin-runtime.md).

## Plugin settings

Declare `settings` in `dispatch-plugin.json`. Core validates the definition and
stores values in the installing DSP's `config/plugins/<plugin>/settings.sqlite3`.
Package updates preserve this database; credentials remain in the DSP vault.
Settings are ordinary configuration, never a credential or browser-state store.

```json
{
  "version": 1,
  "sections": [{ "id": "display", "label": "Display" }],
  "fields": [{
    "id": "included_groups", "section": "display", "label": "Included groups",
    "type": "strings", "nullable": true, "default": null,
    "optionsSource": "groups"
  }],
  "optionsView": "settings-options"
}
```

The optional `optionsView` is a plugin published-read entrypoint. It returns an
object such as `{groups: [{value: "drivers", label: "Drivers", count: 12}]}`.
Stable IDs are saved; changing a label does not change the selection. An empty
array stays empty. A nullable field can use `null` for all current and future
options; the plugin defines that meaning when it consumes the value.

Supported field types are `boolean`, bounded `integer`, `string`, and `strings`.
Fields can declare static options, dynamic options, descriptions and ordered
string selections. Unknown fields, duplicate selections and invalid values fail
validation. Dynamic choices are suggestions from published data: absent saved
IDs are retained, so a temporarily missing group cannot silently change a DSP's
configuration.

Backend workers use `const {values} = await dispatch.settings.get()`. Each worker
receives the settings snapshot captured when that job starts. A save affects new
work; it does not mutate the inputs of a running worker. Ordinary plugin clients
cannot change owner settings or select another DSP.

Frontend plugins import `usePluginSettings`, `PluginSettingsField`, or
`PluginSettingsForm` from `dispatch-sdk/ui`. The form renders declared sections
and fields and provides save, discard, defaults, conflict handling and dynamic
options. `renderSection` adds plugin-specific previews or status components.
Handle `?settings` on the plugin's primary page to support the Plugins page link:

```tsx
<PluginSettingsForm pluginId="example" title="Example settings"
  backHref="#/example" />
```

The hook scopes its cache to the authenticated user, DSP and signed support view.
The Core owner API authenticates each request, verifies CSRF and checks the
current DSP installation. Platform owners in signed DSP views have owner access;
history attributes writes to the actual user. Saves contain complete `values`,
`expectedRevision`, `definitionVersion` and an `idempotencyKey`. Concurrent stale
saves return a conflict. Defaults are a draft until saved.

An optional `schedule: {id, enabled, interval}` binds one declared sync to boolean
and bounded integer settings fields. Core applies it to that DSP's existing
collection scheduler with durable retry. Pausing cancels queued automatic ticks,
allows the current collection to finish, and preserves explicit manual requests.
`Sync now` still respects queue admission, coalescing and retry backoff.

Increment the definition's `version` when changing its fields or constraints.
New fields receive defaults during initialization; saved overrides are retained.
Declarative `migrations: [{fromVersion: 1, rename: {old_name: "new_name"},
remove: ["obsolete"]}]` apply one version at a time. Removed fields must be
declared. Incompatible values fail initialization and restore the fenced
snapshot; they are never silently discarded. A code downgrade requires a
matching state backup. The package version is separate and must increase for
every published change. Core automatically distributes the latest approved
package to installed DSPs; there are no DSP version pins or owner Update buttons.

## Settings intent, behavior and history

Settings snapshots include `sources`, a map from field ID to `default` or
`override`. Owner forms send the complete map with their save. `default` means
that the value follows the plugin's declared default on a versioned update;
`override` preserves an intentional DSP choice, even if it equals the default.
A default-sourced value must equal its declared default. Existing databases with
unknown provenance are conservatively adopted as overrides. Legacy clients that
omit sources preserve unchanged intent and mark changed values as overrides.
Explicit seeds preserve existing operational configuration as overrides.

The form exposes Use plugin default and Keep this value for each field, plus
section and whole-form default restoration. Restores create a draft and require
Save changes. Switching the authenticated DSP view discards the old editor's
draft. Fields may declare `enabledWhen` or `visibleWhen` as
`{field: "automatic_sync", equals: true}`. Disabled and hidden controls retain
values; these presentation rules do not grant or restrict data access. Use
`disabledReason` to explain a dependency.

`rules` declare cross-field warnings or validation errors. An `included` rule
references a string `field` and a strings `selection`; null means unrestricted.
A `requires` rule optionally activates under `when` and checks a `require`
condition. Each rule has an ID, severity (`warning` or `error`) and message.
Errors are enforced by server-side validation, including direct API saves.

`previews` are plugin declarations rendered by the shared form: `choice` supplies
value/text examples, `columns` shows ordered option labels and an optional leading
column, and `selection_count` combines a selected dynamic-options field with its
DSP-local counts, unit and group label. Plugins can still add provider-specific
components through renderSection. `applies` on a field describes `immediate`,
`next_job`, `next_connection` or `schedule` behavior. The form reports the timing
of changed values after saving. This metadata describes the plugin's consumption
contract; it does not mutate an active job's settings snapshot.

Migrations now support `copy: {old: ["new_a", "new_b"]}`,
`mapValues: {field: [{from: "old", to: "new"}]}`, `scale: {field: 60}` and
`reset: ["field"]`, alongside rename/remove. Within a step the order is rename,
copy, mapValues, scale, remove, reset. Copy/map/scale preserve source intent;
reset deliberately follows the new default. Unmatched map values are retained
and must validate against the final definition. Whole-value mappings take
precedence over mapping individual array members. Unknown leftover fields,
collisions and invalid final values fail the fenced installation migration.
Never use reset merely to change defaults for DSPs already following defaults.

The owner-only GET `/api/organization/plugins/<id>/settings/history` returns
bounded, newest-first entries with actor attribution, changes and restoration
snapshots. `?before=<revision>` requests older entries. The browser SDK exposes
`settings.history(beforeRevision)` for an owner-authorized host transport;
ordinary worker and DSP-framework clients cannot read history. The form restores
individual fields or sections from compatible entries into a draft. Entries from
an older definition remain visible but require a migration before their values
can be restored. Values, intent, history and retry receipts remain in the DSP's
settings database and its normal backups. History arrays are abbreviated in
change summaries; restoration snapshots retain their full validated values.

## Operation contracts and plugin development

Declare an action's `input` and optional `output` JSON Schema in the plugin
manifest. `dispatch-sdk/operations` supplies validation and `createOperationClient`;
`dispatch-sdk/plugin` supplies `definePlugin` for data-returning worker handlers.
The HTTP API and worker host independently enforce those declarations. A declared
permission is still subject to current DSP membership and installation authority.

`bin/dispatch plugin generate <id>` creates typed clients and OpenAPI descriptions.
Generated clients accept an invocation function, so they work with a worker's
`dispatch.actions.invoke` or the dashboard's `invokePluginOperation` from
`dispatch-sdk/ui`. The SDK remains the client library; `core/api/` is the separate
HTTP service. It does not replace local SDK storage or private worker transports.

See [plugin development](../docs/plugin-development.md) for the generator, sealed
package build, two-DSP local workspace and executable example. The first contract
pass preserves legacy operations without output schemas; new starters declare
both inputs and outputs. No generated client or schema grants authority.
