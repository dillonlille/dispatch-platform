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

For each meal, the browser selects exactly four timestamps:

1. Last successful package delivery at/before OUT LUNCH.
2. Meal start (OUT LUNCH).
3. Meal end (IN LUNCH).
4. First successful package delivery at/after IN LUNCH.

Delivery selection uses DROP_OFF tasks marked DELIVERED/COMPLETE with valid
execution times. A group stop with deliveries at 2:30 and 2:33 contributes 2:33
before lunch; one with deliveries at 2:50 and 2:52 contributes 2:50 afterward.
Full delivery arrays and task/stop IDs never leave the page. There is no stored
package history or precomputed gap/duration data. Driver, itinerary, meal and scope
identities associate the four timestamps with the correct record.

Amazon's `unknownStops` are unplanned dwell locations with enter/exit times and
coordinates. They do not invalidate otherwise complete delivery-task evidence.
Stop-count mismatches, malformed delivered tasks and conflicting copies of the
same task still withhold delivery boundaries. Identical repeated tasks collapse
in memory. Removed delivered tasks are never attributed to this driver; they
withhold boundaries only if their timestamp is invalid or could be closer to a
meal than the selected active delivery. An unrelated removed task hours away
cannot change either boundary.

Unavailable delivery evidence preserves the meal times with NULL delivery times
and explicit availability statuses. An unfinished route without a next delivery
is pending. A completed route with complete evidence can report verified absence.
Intervals describe recorded events, not driver activity.

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
- `meal_records`: the four timestamps for each logical meal, identity and availability.
- `meal_breaks` and `meal_delivery_events`: empty legacy tables kept for rollback compatibility.

The shared job database owns requests, attempts, progress and failures, avoiding a
second run-status system in Cortex. The browser worker receives only its profile;
the host validates the result and publishes in one Cortex SQLite transaction.
Incomplete/failed jobs preserve the previous accepted dataset. Retrying publication
for the same job is idempotent. Five accepted revisions are retained per date and
station/service-area/provider scope; foreign-key cascades remove older evidence.
Other dates remain stored. Unknown gaps are SQL NULL, never fabricated zeros.

The connection database user_version remains 1. The additive `meal_schema` and
`meal_record_schema` markers distinguish initialized storage from lost tables;
missing initialized tables fail closed. The four-timestamp migration copies
previously verified boundaries into `meal_records` for **all** saved publications,
then deletes every legacy break and delivery-event row in the same transaction.
A fresh collection resolves boundaries previously withheld by the old adapter.

The previous runtime can still start, authenticate and publish after migration.
An activation trigger converts legacy publications into the four-timestamp format
and clears their event rows inside the publication transaction, so rollback cannot
resume retaining delivery histories. New code writes `meal_records` directly.
Recursive backups already include the provider database and encrypted credentials.
There are no raw provider-response archives or exports by default.

## Verification

Rust tests cover timestamp validation, multiple meals, overnight boundaries,
invalid boundaries, request identity, connection revisions, retention, migration
and atomic publication. API tests cover permissions, DSP/provider isolation and
restart persistence. The native BrowserOS fixture exercises main-world extraction,
changes to an existing itinerary's meals, multiple itineraries for one driver,
group-stop extrema, irrelevant unknown stops/removed tasks, failed refresh
preservation and unavailable coverage. Migration tests include historical data
cleanup and publication by the previous runtime.

The inspected legacy reference is
`/home/thepickle/dispatch/plugins/meal-break-gaps/source/collector/collect_cdp.js`.
Its first-meal DOM parser, shared browser, Python importer, Slack/Discord delivery
and fixed daily schedules are not used by this backend.
