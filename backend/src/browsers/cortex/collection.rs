use super::*;
use crate::{
    db::now,
    job_metrics::Recorder,
    meals::{Capture, Itinerary, Scope},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
};
const EXTRACT: &str = include_str!("meal.js");
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
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
        scope: &Scope,
        candidate: Option<&Candidate>,
        metrics: &Recorder,
    ) -> Result<Value> {
        // Main-world access is needed for the observed React props. Bound both
        // the CDP target and the in-page URL before inspecting application data.
        let frame = self.page.frame().await?;
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
            .evaluate(&self.page.id, &call(EXTRACT, &input))
            .await?;
        if let Some(error) = result["error"].as_str() {
            metrics.detail(s(&result, "reason"));
            let allowed = [
                "cortex_scope_mismatch",
                "cortex_content_incomplete",
                "cortex_timezone_mismatch",
                "cortex_source_too_large",
                "cortex_invalid_meal_evidence",
                "cortex_invalid_identity",
                "cortex_source_changed",
                "invalid_cortex_scope",
            ];
            return Err(Error::new(
                if allowed.contains(&error) {
                    error
                } else {
                    "cortex_content_incomplete"
                },
                502,
            ));
        }
        Ok(result)
    }
    async fn meal_page(
        &mut self,
        scope: &Scope,
        candidate: Option<&Candidate>,
        metrics: &Recorder,
    ) -> Result<Value> {
        let path = candidate
            .map(|c| scope.detail_path(&c.id))
            .unwrap_or_else(|| scope.list_path());
        let url = format!("{}{path}", self.origin);
        self.page.start_navigation(&url).await?;
        let deadline = Instant::now() + Duration::from_secs(30);
        // Cortex occasionally settles on another route's details and never
        // corrects itself. One reload recovers it without hiding a real mismatch.
        let mut reload = Some(Instant::now() + Duration::from_secs(10));
        let mut last = None;
        let mut stable = 0;
        let mut last_error = "cortex_content_incomplete".to_owned();
        while Instant::now() < deadline {
            match self.meal_read(scope, candidate, metrics).await {
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
                Err(error)
                    if [
                        "cortex_content_incomplete",
                        "browser_navigation_pending",
                        "browser_script_failed",
                        "cortex_scope_mismatch",
                        "verification_required",
                    ]
                    .contains(&error.code.as_str()) =>
                {
                    last = None;
                    stable = 0;
                    if error.code == "cortex_scope_mismatch"
                        && reload.is_some_and(|at| Instant::now() >= at)
                    {
                        reload = None;
                        self.page.start_navigation(&url).await?;
                    }
                    last_error = error.code;
                }
                Err(error) => return Err(error),
            }
            sleep(Duration::from_millis(300)).await;
        }
        Err(Error::new(&last_error, 502))
    }
    async fn candidates(&mut self, scope: &Scope, metrics: &Recorder) -> Result<Vec<Candidate>> {
        let value = self.meal_page(scope, None, metrics).await?;
        let rows: Vec<Candidate> = serde_json::from_value(value["candidates"].clone())
            .map_err(|_| Error::new("cortex_content_incomplete", 502))?;
        ensure(rows.len() <= 1000, "cortex_source_too_large", 502)?;
        Ok(rows)
    }
    pub async fn collect<F, Fut>(
        &mut self,
        scope: &Scope,
        metrics: &Recorder,
        live: &crate::live_collection::Writer,
        progress: F,
    ) -> Result<Value>
    where
        F: Fn(i64, String) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        scope.validate()?;
        let started_at = now();
        let mut candidates = self.candidates(scope, metrics).await?;
        live.start_cortex(
            scope,
            json!(
                candidates
                    .iter()
                    .map(|c| json!({"id":c.transporter_id,"name":c.driver}))
                    .collect::<Vec<_>>()
            ),
        )
        .await?;
        let mut records: BTreeMap<String, (String, Itinerary)> = BTreeMap::new();
        let mut known = HashSet::new();
        let mut reads = 0;
        // Later passes only re-read routes whose meals changed, so they are short.
        // Swipes arrive every few minutes at midday; allow for several of them.
        for pass in 0..6 {
            for candidate in &candidates {
                known.insert(candidate.id.clone());
                if records
                    .get(&candidate.id)
                    .is_some_and(|(revision, _)| revision == &candidate.revision)
                {
                    continue;
                }
                reads += 1;
                metrics.page_start(reads, 1);
                metrics.page_stage(reads, "content");
                progress(
                    10 + (70 * records.len() / candidates.len().max(1)) as i64,
                    format!(
                        "Reading meal evidence ({}/{})",
                        records.len() + 1,
                        candidates.len()
                    ),
                )
                .await?;
                let result = self.meal_page(scope, Some(candidate), metrics).await;
                metrics.page_finish(reads, result.as_ref().err().map(|e| e.code.as_str()));
                match result {
                    Ok(value) => {
                        let mut route: Itinerary =
                            serde_json::from_value(value["itinerary"].clone())
                                .map_err(|_| Error::new("cortex_content_incomplete", 502))?;
                        route.source_url = Some(format!(
                            "{}{}",
                            self.origin,
                            scope.detail_path(&candidate.id)
                        ));
                        ensure(
                            route.id == candidate.id
                                && route.transporter_id == candidate.transporter_id,
                            "cortex_invalid_identity",
                            502,
                        )?;
                        live.cortex(&Capture {
                            scope: scope.clone(),
                            started_at,
                            finished_at: now(),
                            itineraries: vec![route.clone()],
                        })
                        .await?;
                        records.insert(candidate.id.clone(), (candidate.revision.clone(), route));
                    }
                    // A meal swipe landed after the list was read. Finish the other
                    // routes; the next pass re-reads this one at its new revision.
                    Err(error) if error.code == "cortex_source_changed" => {
                        records.remove(&candidate.id);
                    }
                    Err(error) => return Err(error),
                }
                if reads.is_multiple_of(10) {
                    self.page.collect_garbage().await?;
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
            live.cortex_drivers(json!(
                next.iter()
                    .map(|c| json!({"id":c.transporter_id,"name":c.driver}))
                    .collect::<Vec<_>>()
            ))
            .await?;
            candidates = next;
        }
        Err(Error::new("cortex_source_changed", 502))
    }
}
