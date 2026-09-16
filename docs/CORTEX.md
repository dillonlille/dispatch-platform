# Cortex connection

Cortex authenticates through Amazon Logistics DSP Console at
`https://logistics.amazon.com/dspconsolev2`. Both initial credential entry and
Test Connection use this page. This increment enables connection authentication
only. No Cortex jobs, schedules or collection run yet.

DSP owners use Settings → Connections → Cortex to save an Amazon email address
and password, test the connection or disconnect. Credentials are encrypted with
the DSP vault key and bound to that DSP and provider. They are never returned by
the API. The driver handles separate email and password pages, preserves browser
sessions, and bounds automated submissions with persistent cooldowns and
interruption recovery. Unexpected provider challenges use the existing owner-only
verification window; unknown pages remain unverified.

Readiness requires the DSP Console URL and title, visible weekly scheduling
navigation, and a visible Sign out control. A title or URL alone is insufficient.
Delivery Execution remains the future meal-break collector's destination and is
not the connection test page.

Cortex owns `data/cortex/cortex.sqlite` (schema version 1, connection state and
DSP/provider identity only), `secrets/cortex.enc`, and the registered
`state/browsers/cortex-browseros` profile and `cortex-attempt.json` file. Startup
and provisioning initialize the database before serving traffic. The DSP core's
`storage.cortex` marker distinguishes a new installation from a missing database;
missing or mismatched initialized storage fails closed. This is additive to the
provider layout from PRs #29/#30, and the previous runtime can still use Paycom
without changing Cortex data. Existing recursive backups include Cortex state.
Credential changes/disconnection clear only the selected provider's browser state.
The shared browser capacity still applies across all DSPs and providers.

The provider-specific API is `/api/dsp/connections/cortex` with the existing
`check`, `verify`, `screenshot`, `assist`, `submit` and `disable` actions. Paycom's
legacy `/api/dsp/connections` read remains compatible. No request can supply a
provider URL, profile path or executable.

## Legacy meal break reference

The inspected implementation lives at
`/home/thepickle/dispatch/plugins/meal-break-gaps/source/collector/collect_cdp.js`.
It uses an authenticated Amazon Operations profile and visits itinerary summaries
and each driver's itinerary details for an explicitly selected day. Its output
contains station/service-area context, driver/transporter and itinerary IDs,
route details, real meal start/end times and durations, the nearest verified
successful delivery before and after the meal, and the resulting gaps. It verifies
stable stop/task coverage and quarantines partial results. Stable meals without
provable delivery boundaries retain their meal times with null gaps and explicit
warnings. A later Cortex collector should preserve those evidence requirements
and use each DSP's configuration instead of the legacy hard-coded station and
service area.

Login behavior was inspected in `/usr/lib/dispatch-auth/src/amazon.js`, which
uses Amazon's staged forms and hands OTP/CAPTCHA/security challenges back to the
operator. The platform driver uses its own Rust BrowserOS runtime and a new
DOM-only adapter; it does not reuse the legacy browser, vault or cookies.

## Verification

`tests/cortex.test.ts` covers API permissions, encryption, independent databases,
provider/DSP isolation and disconnect. `tests/cortex-worker.test.ts` exercises the
real Rust driver in sandboxed BrowserOS against staged local forms, OTP, CAPTCHA,
session reuse, invalid credentials and incomplete application loading.
Storage tests cover initialization recovery, identity and missing-file refusal.
The owner successfully signed in with email/password in **Dev DSP**. Read-only
inspection confirmed the signed-in DSP Console at the requested URL. Fixture
coverage reproduces its title, navigation and Sign out control and rejects a
loading shell.
