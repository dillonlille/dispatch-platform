use super::*;
use crate::{
    db::now,
    job_metrics::Recorder,
    live_collection::Writer,
    meals::{Capture, Itinerary, Scope},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
/// Route pages read at once, each in its own tab. Two read ten real routes in 30 s
/// instead of 42 s for 6% more memory; more share the same renderer and connection.
pub(super) const TABS: usize = 2;
// The route's content has not settled yet; read it again.
pub(super) const CONTENT_NOT_READY: &[crate::Code] = &[
    crate::Code::CortexContentIncomplete,
    crate::Code::BrowserNavigationPending,
    crate::Code::BrowserScriptFailed,
    crate::Code::CortexScopeMismatch,
    crate::Code::VerificationRequired,
];
const EXTRACT: &str = include_str!("meal.js");
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Candidate {
    id: String,
    transporter_id: String,
    driver: String,
    route: String,
    route_complete: bool,
    meals: Vec<Punch>,
    revision: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Punch {
    id: String,
    start: i64,
    end: Option<i64>,
}
impl Driver {
    async fn meal_read(
        &self,
        page: &Page,
        scope: &Scope,
        candidate: Option<&Candidate>,
        metrics: &Recorder,
    ) -> Result<Value> {
        // Main-world access is needed for the observed React props. Bound both
        // the CDP target and the in-page URL before inspecting application data.
        let frame = page.frame().await?;
        let url = url::Url::parse(s(&frame, "url"))
            .map_err(|_| Error::new("cortex_content_incomplete", 502))?;
        ensure(
            url.origin().ascii_serialization() == self.origin,
            "verification_required",
            409,
        )?;
        let input = json!({"kind":if candidate.is_some(){"detail"}else{"list"},"scope":scope,"candidate":candidate,"origin":self.origin});
        let result = self
            .browser
            .evaluate(&page.id, &call(EXTRACT, &input))
            .await?;
        if let Some(error) = result["error"].as_str() {
            metrics.detail(s(&result, "reason"));
            let allowed = [
                crate::Code::CortexScopeMismatch,
                crate::Code::CortexContentIncomplete,
                crate::Code::CortexTimezoneMismatch,
                crate::Code::CortexSourceTooLarge,
                crate::Code::CortexInvalidMealEvidence,
                crate::Code::CortexInvalidIdentity,
                crate::Code::CortexSourceChanged,
                crate::Code::InvalidCortexScope,
            ];
            return Err(Error::new(
                if crate::Code::text_is_any(error, &allowed) {
                    error
                } else {
                    "cortex_content_incomplete"
                },
                502,
            ));
        }
        Ok(result)
    }
    pub(super) async fn meal_page(
        &self,
        page: &Page,
        scope: &Scope,
        candidate: Option<&Candidate>,
        metrics: &Recorder,
    ) -> Result<Value> {
        let path = candidate
            .map(|c| scope.detail_path(&c.id))
            .unwrap_or_else(|| scope.list_path());
        let url = format!("{}{path}", self.origin);
        page.start_navigation(&url).await?;
        let deadline = Instant::now() + Duration::from_secs(30);
        // Cortex occasionally settles on another route's details and never
        // corrects itself. One reload recovers it without hiding a real mismatch.
        let mut reload = Some(Instant::now() + Duration::from_secs(10));
        let mut last = None;
        let mut stable = 0;
        let mut last_error = "cortex_content_incomplete".to_owned();
        while Instant::now() < deadline {
            match self.meal_read(page, scope, candidate, metrics).await {
                Ok(value) => {
                    let mut evidence = value.clone();
                    if let Some(itinerary) = evidence["itinerary"].as_object_mut() {
                        itinerary.remove("observedAt");
                    }
                    if last.as_ref() == Some(&evidence) {
                        stable += 1;
                    } else {
                        stable = 0;
                    }
                    last = Some(evidence);
                    if stable >= 2 {
                        return Ok(value);
                    }
                }
                Err(error) if error.is_any(CONTENT_NOT_READY) => {
                    last = None;
                    stable = 0;
                    if error.is(crate::Code::CortexScopeMismatch)
                        && reload.is_some_and(|at| Instant::now() >= at)
                    {
                        reload = None;
                        page.start_navigation(&url).await?;
                    }
                    last_error = error.code;
                }
                Err(error) => return Err(error),
            }
            sleep(Duration::from_millis(300)).await;
        }
        Err(Error::new(&last_error, 502))
    }
    pub(super) async fn candidates(
        &self,
        scope: &Scope,
        metrics: &Recorder,
    ) -> Result<Vec<Candidate>> {
        let value = self.meal_page(&self.page, scope, None, metrics).await?;
        let rows: Vec<Candidate> = serde_json::from_value(value["candidates"].clone())
            .map_err(|_| Error::new("cortex_content_incomplete", 502))?;
        ensure(rows.len() <= 1000, "cortex_source_too_large", 502)?;
        Ok(rows)
    }
    /// Every route of the scope's day, read until one pass finds each route's record
    /// at its latest revision. `tabs` route pages are read at once, each in its own tab.
    pub async fn collect<F, Fut>(
        &mut self,
        scope: &Scope,
        metrics: &Recorder,
        live: Option<&Writer>,
        progress: F,
        tabs: usize,
    ) -> Result<Value>
    where
        F: Fn(i64, String) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        scope.validate()?;
        let started_at = now();
        let candidates = self.candidates(scope, metrics).await?;
        if let Some(live) = live {
            live.start_cortex(scope, drivers(&candidates)).await?;
        }
        // Tabs beside the first, opened once and kept for every pass. Each has its
        // own window: Cortex can stop loading a route in a hidden background tab.
        let mut others = Vec::new();
        for _ in 1..tabs.min(candidates.len()) {
            let mut page = Page::open_window(self.browser.clone(), self.origin.clone()).await?;
            page.allow_origins(&self.origins.iter().map(String::as_str).collect::<Vec<_>>());
            others.push(page);
        }
        let result = self
            .passes(
                scope, metrics, live, &progress, candidates, &others, started_at,
            )
            .await;
        // Close the extra windows, so they hold no memory while the capture is published.
        for page in &others {
            let _ = page.close().await;
        }
        result
    }
    /// Reads until one pass finds every listed route's record at its latest revision.
    #[allow(clippy::too_many_arguments)]
    async fn passes<F, Fut>(
        &self,
        scope: &Scope,
        metrics: &Recorder,
        live: Option<&Writer>,
        progress: &F,
        mut candidates: Vec<Candidate>,
        others: &[Page],
        started_at: i64,
    ) -> Result<Value>
    where
        F: Fn(i64, String) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let mut records: BTreeMap<String, (String, Itinerary)> = BTreeMap::new();
        let mut known = HashSet::new();
        let reads = AtomicUsize::new(0);
        // Later passes only re-read routes whose meals changed, so they are short.
        // Swipes arrive every few minutes at midday; allow for several of them.
        for pass in 0..6 {
            known.extend(candidates.iter().map(|c| c.id.clone()));
            let lanes = {
                let routes = Routes {
                    driver: self,
                    scope,
                    pending: candidates
                        .iter()
                        .filter(|c| {
                            records
                                .get(&c.id)
                                .is_none_or(|(revision, _)| revision != &c.revision)
                        })
                        .collect(),
                    next: AtomicUsize::new(0),
                    stopped: AtomicBool::new(false),
                    reads: &reads,
                    done: AtomicUsize::new(records.len()),
                    total: candidates.len(),
                    metrics,
                    live,
                    started_at,
                    progress,
                };
                // Drain every tab even when one fails. Dropping a sibling's in-flight
                // command closes the shared browser transport.
                futures_util::future::join_all(
                    std::iter::once(&self.page)
                        .chain(others)
                        .map(|page| routes.lane(page)),
                )
                .await
            };
            for lane in lanes {
                for (id, read) in lane? {
                    match read {
                        Some(record) => records.insert(id, record),
                        // A meal swipe landed after the list was read. The next pass
                        // re-reads this route at its new revision.
                        None => records.remove(&id),
                    };
                }
            }
            progress(85, format!("Checking source changes (pass {})", pass + 1)).await?;
            let next = self.candidates(scope, metrics).await?;
            let ids: HashSet<_> = next.iter().map(|c| c.id.clone()).collect();
            ensure(known.is_subset(&ids), "cortex_membership_regressed", 502)?;
            if next.len() == records.len()
                && next.iter().all(|c| {
                    records
                        .get(&c.id)
                        .is_some_and(|(revision, _)| revision == &c.revision)
                })
            {
                let capture = Capture {
                    scope: scope.clone(),
                    started_at,
                    finished_at: now(),
                    itineraries: records.into_values().map(|(_, route)| route).collect(),
                };
                capture.validate(scope)?;
                progress(95, "Validating meal publication".into()).await?;
                return Ok(serde_json::to_value(capture)?);
            }
            if let Some(live) = live {
                live.cortex_drivers(drivers(&next)).await?;
            }
            candidates = next;
        }
        Err(Error::new("cortex_source_changed", 502))
    }
}

/// The drivers a list names, as the live view shows them.
fn drivers(candidates: &[Candidate]) -> Value {
    json!(
        candidates
            .iter()
            .map(|c| json!({"id":c.transporter_id,"name":c.driver}))
            .collect::<Vec<_>>()
    )
}

/// One pass over the routes whose record is missing or out of date, shared by the tabs.
struct Routes<'a, F> {
    driver: &'a Driver,
    scope: &'a Scope,
    pending: Vec<&'a Candidate>,
    next: AtomicUsize,
    stopped: AtomicBool,
    reads: &'a AtomicUsize,
    done: AtomicUsize,
    total: usize,
    metrics: &'a Recorder,
    live: Option<&'a Writer>,
    started_at: i64,
    progress: &'a F,
}
/// A route's record at the revision it was read, or `None` when it changed meanwhile.
type Read = (String, Option<(String, Itinerary)>);
impl<F, Fut> Routes<'_, F>
where
    F: Fn(i64, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    async fn lane(&self, page: &Page) -> Result<Vec<Read>> {
        let result = self.read(page).await;
        if result.is_err() {
            self.stopped.store(true, Ordering::SeqCst);
        }
        result
    }
    async fn read(&self, page: &Page) -> Result<Vec<Read>> {
        let mut reads = Vec::new();
        while !self.stopped.load(Ordering::SeqCst) {
            let Some(candidate) = self.pending.get(self.next.fetch_add(1, Ordering::SeqCst)) else {
                break;
            };
            let ordinal = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            self.metrics.page_start(ordinal, 1);
            self.metrics.page_stage(ordinal, "content");
            let done = self.done.load(Ordering::SeqCst);
            (self.progress)(
                10 + (70 * done / self.total.max(1)) as i64,
                format!("Reading meal evidence ({}/{})", done + 1, self.total),
            )
            .await?;
            let result = self
                .driver
                .meal_page(page, self.scope, Some(candidate), self.metrics)
                .await;
            self.metrics
                .page_finish(ordinal, result.as_ref().err().map(|e| e.code.as_str()));
            match result {
                Ok(value) => {
                    let mut route: Itinerary =
                        serde_json::from_value(value["itinerary"].clone())
                            .map_err(|_| Error::new("cortex_content_incomplete", 502))?;
                    route.source_url = Some(format!(
                        "{}{}",
                        self.driver.origin,
                        self.scope.detail_path(&candidate.id)
                    ));
                    ensure(
                        route.id == candidate.id
                            && route.transporter_id == candidate.transporter_id,
                        "cortex_invalid_identity",
                        502,
                    )?;
                    if let Some(live) = self.live {
                        live.cortex(&Capture {
                            scope: self.scope.clone(),
                            started_at: self.started_at,
                            finished_at: now(),
                            itineraries: vec![route.clone()],
                        })
                        .await?;
                    }
                    self.done.fetch_add(1, Ordering::SeqCst);
                    reads.push((
                        candidate.id.clone(),
                        Some((candidate.revision.clone(), route)),
                    ));
                }
                Err(error) if error.is(crate::Code::CortexSourceChanged) => {
                    reads.push((candidate.id.clone(), None));
                }
                Err(error) => return Err(error),
            }
            if reads.len().is_multiple_of(10) {
                page.collect_garbage().await?;
            }
        }
        Ok(reads)
    }
}
