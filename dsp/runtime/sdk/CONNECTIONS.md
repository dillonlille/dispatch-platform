# Shared service connections

DSP owners manage **Cortex** and **Paycom** under **Settings → Connections**.
Each service has one credential set per DSP. Internal identities are fixed in
`shared/contracts/src/connections.js`: Cortex uses `amazon-operations` and
Paycom uses `paycom-main`. Existing profiles under those names are discovered
without copying or reentering credentials. Existing collector definitions with
other explicitly selected profiles retain their legacy behavior.

The dashboard routes management requests through the authenticated, selected DSP
runtime. It never accepts a runtime key, profile name, provider name, endpoint,
or website URL from the credential form. Both the selected membership's Owner
role and permission are required. Platform support viewing does not grant
credential management. The DSP broker stores provider credentials in its
existing encrypted vault; Core stores audit metadata only.

Save, test, and disconnect return bounded status views. A save carries a short
expiry and credentials travel in the live transport only. Login checks run in
the broker and survive page navigation. After a broker restart an unfinished
check is reported as unavailable, never as authenticated. Last-check timestamps
describe a past verification, not a guarantee that the provider's session will
remain valid. Current sessions are checked by the adapter when acquired.

Paycom first enrollment still uses the existing onboarding worker to verify
login and start workforce collection. Later credential changes use the same
fixed vault profile. Connection management refuses changes while the profile is
in use; try again after collection finishes. Replacement removes retained browser
authentication before saving the new account. Disconnect removes credentials and
browser state and prevents new acquisitions; previously collected data remains.

## Feature access inside a DSP runtime

Use the SDK's connection client from an authorized feature worker:

```js
const { createLocalDispatchClient } = require('./src');
const dispatch = createLocalDispatchClient({ runtime: trustedRuntimePaths });

const result = await dispatch.connections.withSession(
  { service: 'cortex', feature: 'delivery-reports', runId, signal },
  async ({ endpoint, protocol, access, signal }) => {
    return collectReports({ endpoint, protocol, access, signal });
  },
);
```

The callback receives CDP access to an authenticated browser, never vault
credentials. The helper renews its lease, propagates cancellation and renewal
failure, and releases the browser on success or failure. Callbacks must honor
the signal. The broker allows one operation per profile; `session_busy` means
the caller should queue/retry through its scheduler, not start another login.
The owning DSP runtime provides isolation. Feature authorization belongs in the
feature's existing API/worker boundary; the feature label is attribution, not
an independent authorization credential. Browser endpoints and leases must stay
inside the runtime, not in dashboard responses.

CDF and Paycom's default browser acquisition paths use this same service mapping.
For low-level workers the shared `acquireServiceBrowser` helper returns a lease
that the worker must renew and release itself.

## Additional services and verification

Add a service definition with fixed provider/profile identities and bounded
credential fields, register its authentication adapter, and extend contract and
integration coverage. The settings form is generated from the service registry.
Changing credential limits also requires checking transport byte limits.

MFA, CAPTCHA, and unfamiliar security challenges are human intervention states.
This change reports them and supports retry after operator recovery; it does not
provide an interactive challenge browser or collect verification codes in the
dashboard. Unsupported adapter flows remain blocked rather than bypassed.
