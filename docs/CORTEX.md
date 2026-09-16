# Cortex connection and meal collection

Cortex authenticates through Amazon Logistics DSP Console at
`https://logistics.amazon.com/dspconsolev2`. Initial credential entry and Test
Connection use that page. The owner verified a real email/password login in Dev.
Credentials are DSP/provider-bound and encrypted; each DSP has a separate Cortex
BrowserOS profile. Collection uses the same session at Delivery Execution.

## Backend collection

There is no meal dashboard or automatic schedule in this increment. Authorized
DSP owners/managers can queue an explicitly dated collection:

```http
POST /api/dsp/cortex/meal-breaks/collect
Content-Type: application/json

{
  "requestId": "unique-request-id",
  "date": "2026-01-10",
  "station": "EX01",
  "serviceAreaId": "amazon-service-area-id",
  "provider": "amazon-company-id",
  "timezone": "America/Los_Angeles"
}
```

The normal session, CSRF and DSP-view authorization apply. A request returns HTTP
202 with a `cortex.meal_breaks.collect` job. Reusing a request ID returns the same
job only for the same provider and request. A different request conflicts. Poll
`GET /api/dsp/jobs`; use its existing cancellation endpoint. Credentials changing,
DSP suspension, actor access revocation and lease loss prevent publication.

`timezone` defaults to the DSP timezone, but should explicitly name the station's
IANA timezone when different. Amazon's selected station and timezone must match.
`provider` accepts an account-visible company ID or the explicit `ALL_DRIVERS`
scope; no station, service area or company is hard-coded. The adapter validates
the selected date, station, service area and provider against the authenticated
application, including itinerary detail identity. It never accepts a source URL.

Operators can also enqueue with the platform service **stopped**, using the normal
private environment configuration and platform lock:

```text
dispatch-backend enqueue-cortex-meals DSP_ID YYYY-MM-DD STATION SERVICE_AREA_ID PROVIDER TIMEZONE REQUEST_ID
```

Restart the service to execute the durable job. The command does not require or
print credentials. This is an operator interface; online clients should use the
authorized API above.

`GET /api/dsp/cortex/meal-breaks?date=YYYY-MM-DD` reads accepted publication
metadata and counts for that DSP/date. It does not collect or refresh data.

## Extraction and evidence

The adapter reads the current application's `allItinerarySummaries`,
`transporterSummary`, and `itineraryDetails` React props. Live inspection confirmed
structured `breaks`, `stops[].tasks`, epoch meal times and successful task execution
times. It reads only selected fields in the application world; it does not export
addresses, package references, page text, credentials or tokens. This is an
observed Amazon application contract, not a documented public API. Changes to it
must fail validation and receive adapter updates.

Every itinerary is read, including those with no meal. Multiple itineraries for
the same transporter and all recorded MEAL breaks are retained. REST breaks are
outside this collector. Completed meals and ongoing meals have distinct states.
Meals use Amazon's logical `breakId`, rather than an individual `punchId`. When
the same break/sequence retains both an ON punch and an OFF record, the completed
record supplies the meal interval, provided that it contains the ON timestamp.
Identical copies collapse; conflicting completed intervals still fail validation.
Seconds and milliseconds are normalized to full timestamps; no clock-only
arithmetic or Pacific timezone assumption is used. The itinerary's operating date
can include an overnight continuation, bounded to 48 hours from local midnight.

Gap evidence uses unique DROP_OFF tasks marked DELIVERED/COMPLETE with valid
execution timestamps. The nearest event at/before meal start and at/after meal
end is selected across the captured itinerary. Multiple tasks in the same minute
remain separate. Source stop counts, unique stop/task identities and unknown or
removed tasks determine delivery coverage. Unavailable delivery coverage preserves
verified meal times while withholding gaps. A missing next event on an unfinished
route is pending, not zero. A completed route with complete evidence can report
verified absence. Intervals describe recorded events, not driver activity.

Amazon can repeat the same task across overlapping stop groups. Identical task
facts are stored once, with a deterministic supporting stop ID. Copies that
disagree on task type, state, completion, time or transporter are excluded from
delivery evidence and make that itinerary's gap coverage unavailable.

The adapter requires repeated stable observations. After reading details it
recaptures the list, comparing meal content, execution status and progress/event
revisions, not just driver membership. Newly added or changed itineraries are
re-read in up to three passes. Shrinking membership, scope mismatch, malformed
meals and unstable evidence cannot replace the accepted publication. Transient
browser/content failures use bounded shared-job retries. Cancellation closes only
the applicable provider session. One active job per DSP and shared browser/memory
admission remain enforced.

## Storage and rollback

Each DSP owns `data/cortex/cortex.sqlite`. Its existing connections and
storage_identity tables are unchanged. The additive meal feature schema includes:

- `meal_publications`: scope, job identity, timestamps, counts and adapter version.
- `meal_itineraries`: transporter/route identity, observation time and coverage.
- `meal_breaks`: every meal, duration, boundary event references, gaps and statuses.
- `meal_delivery_events`: supporting successful task/stop IDs and timestamps.

The shared job database owns requests, attempts, progress and failures, avoiding a
second run-status system in Cortex. The browser worker receives only its profile;
the host validates the result and publishes in one Cortex SQLite transaction.
Incomplete/failed jobs preserve the previous accepted dataset. Retrying publication
for the same job is idempotent. Five accepted revisions are retained per date and
station/service-area/provider scope; foreign-key cascades remove older evidence.
Other dates remain stored. Unknown gaps are SQL NULL, never fabricated zeros.

The connection database user_version remains 1 with an explicit additive
`meal_schema` feature marker. Existing databases initialize before serving traffic;
missing initialized feature tables fail closed. The shared job migration preserves
existing jobs/metrics while extending allowed job kinds and adding a defaulted
request column. The previous runtime can still use Paycom and Cortex authentication
and retain meal data; executing Cortex meal jobs requires the new runtime. Recursive
backups already include the provider database and encrypted credentials. There are
no raw provider-response archives or exports by default.

## Verification

Rust tests cover timestamp validation, multiple meals, overnight boundaries,
duplicate evidence, request identity, connection revisions, retention, migration
and atomic publication. API tests cover permissions, DSP/provider isolation and
restart persistence. The native BrowserOS fixture exercises main-world extraction,
changes to an existing itinerary's meals, multiple itineraries for one driver,
exact task timestamps, failed refresh preservation and unavailable coverage.

The inspected legacy reference is
`/home/thepickle/dispatch/plugins/meal-break-gaps/source/collector/collect_cdp.js`.
Its first-meal DOM parser, shared browser, Python importer, Slack/Discord delivery
and fixed daily schedules are not used by this backend.
