# Collection operations

## Per-attempt diagnostics

DSP Jobs and platform Diagnostics show the latest collection duration and peak
browser memory. Expand **Attempt details** for every attempt, including failures,
retries and interrupted work:

- Outcome and failure reason, retained even after a successful retry.
- Queue wait since the attempt became eligible; scheduled retry backoff is excluded.
- Browser startup/sign-in, human verification, collection and publication durations.
- Employee and daily-record counts after the full collection validates.
- Peak PSS, private memory and summed RSS for the browser supervisor and descendants.

PSS accounts for shared pages proportionally; RSS can count shared pages more than
once. Memory is sampled approximately once per second, so short spikes can be
missed. Collection timings include the sampling overhead. PSS and private peaks
use complete samples only; the UI reports incomplete samples. An unavailable
measurement is shown as unavailable, never as zero. Fixture-only jobs without a
browser have no memory samples. These figures exclude the platform process.

Metrics are saved once per second and on completion in an additive `job_metrics`
table. No credentials, employee details, browser contents or process arguments are
stored. The existing DSP authorization applies to diagnostics. Previous releases
ignore the extra table during rollback. Historical jobs show **Not recorded**.
After a crash, the interrupted attempt retains its last saved measurements, and
its retry gets a new record. Cancellation cannot overwrite a previous attempt.

## Repeatable capacity check

The native suite runs three independent DSP accounts against a local Paycom-shaped
fixture through real isolated BrowserOS processes. It queues two collections for
one DSP and one for each of the others, checking:

- At most two browsers and one active collection per DSP.
- Two overlapping timecard requests per browser, four across both browsers.
- The third DSP starts before the first DSP gets its second collection.
- Distinct credentials, profiles and employee publications remain isolated.
- Health, job, session and employee API reads remain responsive during collection.
- Every browser closes after work, with per-job metrics retained.

The default is 21 employees per DSP. A larger local run uses:

```bash
DISPATCH_TEST_NATIVE=1 DISPATCH_CAPACITY_EMPLOYEES=102 \
DISPATCH_BWRAP_EXECUTABLE=/usr/local/libexec/dispatch-dev/bwrap \
npx tsx --test tests/multi-dsp-browser.test.ts
```

The `CAPACITY` output contains only aggregate timings, memory and counts. Its
memory sample covers the fixture platform and all browser descendants together.
The API figure is the p95 duration of a parallel batch of four read requests.

Synthetic pages are much lighter than real Paycom. This test verifies scheduling,
isolation and responsiveness, not production capacity. Keep the configured limit
at two browsers until measurements with several real DSP accounts support a change.
