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

## Timecard recovery and stall diagnostics

Each employee page gets at most two reads within a collection. A navigation stall
(45 seconds), incomplete page load (30 seconds after navigation), or a completed
page still missing the timecard tables after three seconds gets one local retry.
Only that employee reloads in a replacement tab; already validated records stay
in Rust memory. Navigation waits use bounded browser events instead of renderer
queries that can block before response headers arrive. Reads
from both tabs settle without cancelling the other tab's browser command.

Authentication redirects, provider throttling/server errors, extraction failures
and identity/hours validation errors do not trigger a local retry. Whole-job
transient failures retain exponential backoff, now with stable per-job jitter:
60–90 seconds before attempt two and 120–180 seconds before attempt three.
Persistent missing content fails after the second read. Publication still requires
the complete roster and all validated timecards; failed/cancelled work preserves
the last successful publication. In-memory progress does not survive a browser
crash or platform restart.

Attempt details include completed employee pages, local retries and recoveries,
up to two active reads, the five slowest reads and the eight most recent failed
reads. Each includes the employee's ordinal in this collection, read attempt,
navigation/content/extraction durations and a sanitized failure code. Ordinals
are progress positions, not employee identifiers. Page durations overlap across
tabs and must not be added to derive wall-clock collection time. These optional
JSON fields preserve compatibility with older metrics and rollback builds.

## Memory-aware admission

The hard limit remains two browsers. Before reserving a new session, the shared
browser manager checks Linux `MemAvailable` and visible cgroup v2 ancestor limits.
It budgets 1 GiB for a new browser and 512 MiB of host headroom, plus the remaining
1 GiB growth allowance of each current browser. Complete PSS samples offset only
the resident portion already counted in available memory. Starting or unsampled
browsers reserve the full allowance. Check and reservation serialize under the
same registry lock, covering both scheduled collections and settings-page sign-in.

Jobs stay queued under pressure, and an admission race does not consume a provider
attempt. Queued jobs resume automatically when resources return; active browsers
are not killed. Platform Diagnostics shows available and required memory. Unknown
memory blocks new native browsers. This is a conservative admission estimate,
not an enforced per-browser memory limit; a provider page can exceed its budget.
The capacity fixture accepts serial execution when memory prevents a second
browser, and reports that condition in its aggregate output.

The ancestor-limit calculation follows the Linux [cgroup v2 memory controller](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Read-only response experiment

The ignored operator benchmark accepts `DISPATCH_BENCHMARK_RESPONSE=1`. After a
normal validated collection, it fetches six existing timecard URLs through the
same authenticated, restricted browser session and applies the existing extractor
to detached HTML. Responses are limited to 2 MiB/30 seconds; raw HTML is never
written or printed, and the benchmark does not publish data. It reports structure,
validation, parity and timing aggregates only.

Detached HTML deliberately executes no scripts ([DOMParser behavior](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString)). This is a feasibility probe for a future
Rust parser, not a production collection path. Rendered visibility, selected
control values and dynamically populated content must all be accounted for before
replacing the browser extraction. Six matches would justify broader testing, not
a production switch by themselves.
