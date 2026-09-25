//! A week's scorecard. The overview page's own first data request names the API
//! and the parameters that identify this DSP; the datasets are then read over
//! plain HTTP with the browser's session, a few at once.
use super::*;
use crate::{
    browsers::http::{Http, Refusal},
    db::now,
    job_metrics::Recorder,
    scorecard::{
        Capture, Collection, DATASETS, Dataset, DatasetCapture, MAX_ROWS, POSTED_SIGNAL, Request,
        token,
    },
};
use std::sync::atomic::{AtomicUsize, Ordering};

/// As much as one dataset may send. The largest week seen was 2 MB.
const LIMIT: usize = 16 * 1024 * 1024;
/// Datasets read at once.
const LANES: usize = 4;
const OVERVIEW: &str = "/performance?pageId=dsp_dashboard_overview";

/// Where the page sends its data requests, and how it names this DSP there.
struct Api {
    /// The origin and path up to the version segment.
    base: String,
    /// The `dsp` parameter, the DSP's code.
    dsp: String,
    /// The `companyId` the page settled on.
    company_id: String,
}
impl Api {
    fn address(&self, dataset: &Dataset, station: &str, from: &str, to: &str) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("dataSetId", dataset.id)
            .append_pair("dsp", &self.dsp)
            .append_pair("from", from);
        if let Some(program) = dataset.program {
            query.append_pair("program", program);
        }
        query
            .append_pair("station", station)
            .append_pair("timeFrame", dataset.time_frame.as_str())
            .append_pair("to", to);
        format!("{}/getData?{}", self.base, query.finish())
    }
}
fn refused(refusal: Refusal, metrics: &Recorder) -> Error {
    match refusal {
        Refusal::Unavailable => Error::new("provider_unavailable", 502),
        Refusal::Unreadable(label) => {
            metrics.detail(label);
            Error::new("scorecard_api_unreadable", 502)
        }
    }
}
/// The rows of a data reply for `dataset`: `tableData.<dataset>.rows`, each a JSON
/// object or a JSON string holding one. A reply without the dataset has no rows.
fn rows(dataset: &str, value: &Value) -> Result<Vec<Value>> {
    let invalid = || Error::new("scorecard_row_invalid", 502);
    let tables = value["tableData"].as_object().ok_or_else(invalid)?;
    let Some(table) = tables.get(dataset) else {
        return Ok(Vec::new());
    };
    let rows = table["rows"].as_array().ok_or_else(invalid)?;
    ensure(rows.len() <= MAX_ROWS, "scorecard_source_too_large", 502)?;
    rows.iter()
        .map(|row| {
            let row = match row {
                Value::String(text) => serde_json::from_str(text).map_err(|_| invalid())?,
                other => other.clone(),
            };
            ensure(row.is_object(), "scorecard_row_invalid", 502)?;
            Ok(row)
        })
        .collect()
}
/// The API a data request names: its base address, the `dsp` code and the station.
fn data_request(url: &str, origin: &str) -> Result<(String, String, String)> {
    let incomplete = || Error::new("cortex_content_incomplete", 502);
    let url = url::Url::parse(url).map_err(|_| incomplete())?;
    ensure(
        url.origin().ascii_serialization() == origin,
        "cortex_scope_mismatch",
        502,
    )?;
    let segments: Vec<&str> = url.path().trim_matches('/').split('/').collect();
    ensure(
        segments.len() == 4
            && segments[..2] == ["performance", "api"]
            && token(segments[2], 32)
            && segments[3] == "getData",
        "cortex_content_incomplete",
        502,
    )?;
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let dsp = query
        .get("dsp")
        .filter(|value| token(value, 32))
        .ok_or_else(incomplete)?;
    Ok((
        format!("{origin}/performance/api/{}", segments[2]),
        dsp.clone(),
        query.get("station").cloned().unwrap_or_default(),
    ))
}

impl Driver {
    /// Lets every request still paused go on. After `Fetch.disable` the browser has
    /// released them itself, and continuing one again only errors.
    async fn release_paused(&self) {
        while let Ok(event) = self.browser.event(&self.page.id).await {
            if event.is_null() {
                break;
            }
            let _ = self
                .page
                .command(
                    "Fetch.continueRequest",
                    json!({"requestId":event["requestId"]}),
                )
                .await;
        }
    }
    /// Opens the overview and watches the page's data requests until one is for the
    /// request's station. The page settles on a station of its own first; when that
    /// is another one, it is asked for the station explicitly, and requests the
    /// earlier page still had in flight are let go.
    async fn scorecard_api(&mut self, request: &Request, metrics: &Recorder) -> Result<Api> {
        self.page
            .command(
                "Fetch.enable",
                json!({"patterns":[{"urlPattern":"*/performance/api/*getData*","requestStage":"Request"}]}),
            )
            .await?;
        let result = self.observe_api(request, metrics).await;
        let _ = self.page.command("Fetch.disable", json!({})).await;
        self.release_paused().await;
        result
    }
    async fn observe_api(&mut self, request: &Request, metrics: &Recorder) -> Result<Api> {
        let mut found = None;
        for attempt in 0..2 {
            let address = if attempt == 0 {
                format!("{}{OVERVIEW}", self.origin)
            } else {
                metrics.detail("station_navigation");
                format!("{}{OVERVIEW}&station={}", self.origin, request.station)
            };
            self.page.start_navigation(&address).await?;
            let deadline = Instant::now() + Duration::from_secs(60);
            while found.is_none() {
                ensure(Instant::now() < deadline, "cortex_content_incomplete", 502)?;
                let event = self.browser.event(&self.page.id).await?;
                if event.is_null() {
                    continue;
                }
                // Every paused request goes on, watched or not: the page must keep loading.
                self.page
                    .command(
                        "Fetch.continueRequest",
                        json!({"requestId":event["requestId"]}),
                    )
                    .await?;
                let url = s(&event["request"], "url");
                if event["request"]["method"] != "GET" || !url.contains("/getData") {
                    continue;
                }
                let (base, dsp, station) = data_request(url, &self.origin)?;
                if station == request.station {
                    found = Some((base, dsp));
                } else if attempt == 0 {
                    // The page's own choice; ask for the station instead.
                    metrics.detail("station_mismatch");
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        let (base, dsp) = found.ok_or_else(|| Error::new("cortex_station_unavailable", 502))?;
        // Stop intercepting before waiting on the page: nothing else must be held up.
        self.page.command("Fetch.disable", json!({})).await?;
        self.release_paused().await;
        // The page names the company in its own address once it has settled.
        let settled = Instant::now() + Duration::from_secs(15);
        let company_id = loop {
            let frame = self.page.frame().await?;
            let company = url::Url::parse(s(&frame, "url"))
                .ok()
                .filter(|u| u.origin().ascii_serialization() == self.origin)
                .and_then(|u| {
                    u.query_pairs()
                        .find(|(key, _)| key == "companyId")
                        .map(|(_, value)| value.into_owned())
                })
                .filter(|value| token(value, 128));
            if let Some(company) = company {
                break company;
            }
            ensure(Instant::now() < settled, "cortex_content_incomplete", 502)?;
            sleep(Duration::from_millis(300)).await;
        };
        Ok(Api {
            base,
            dsp,
            company_id,
        })
    }
    pub(super) async fn collect_scorecard(
        &mut self,
        request: &Request,
        run: &Run<'_>,
    ) -> Result<Capture> {
        request.validate()?;
        let started_at = now();
        run.progress(10, "Finding the scorecard".into()).await?;
        let api = self.scorecard_api(request, run.metrics).await?;
        run.progress(20, "Reading scorecard datasets".into())
            .await?;
        let http = Http::signed_in(&self.browser, &self.origin).await?;
        let referer = format!("{}/performance", self.origin);
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let lanes = futures_util::future::join_all((0..LANES).map(|_| async {
            let mut read = Vec::new();
            loop {
                let index = next.fetch_add(1, Ordering::SeqCst);
                let Some(dataset) = DATASETS.get(index) else {
                    break;
                };
                let (from, to) = request.interval(dataset)?;
                let source_url = api.address(dataset, &request.station, &from, &to);
                let value = http
                    .json(&source_url, &referer, LIMIT)
                    .await
                    .map_err(|refusal| refused(refusal, run.metrics))?;
                let rows = rows(dataset.id, &value)?;
                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                run.progress(
                    20 + (70 * finished / DATASETS.len()) as i64,
                    format!("Reading scorecard datasets ({finished}/{})", DATASETS.len()),
                )
                .await?;
                read.push((
                    index,
                    DatasetCapture {
                        id: dataset.id.into(),
                        from,
                        to,
                        source_url,
                        rows,
                    },
                ));
            }
            Ok::<_, Error>(read)
        }))
        .await;
        let mut datasets: Vec<Option<DatasetCapture>> = DATASETS.iter().map(|_| None).collect();
        for lane in lanes {
            for (index, captured) in lane? {
                datasets[index] = Some(captured);
            }
        }
        let datasets = datasets
            .into_iter()
            .map(|d| d.ok_or_else(|| Error::new("scorecard_capture_invalid", 502)))
            .collect::<Result<Vec<_>>>()?;
        let posted = datasets
            .iter()
            .find(|d| d.id == POSTED_SIGNAL)
            .is_some_and(|d| !d.rows.is_empty());
        run.progress(95, "Validating scorecard".into()).await?;
        let capture = Capture {
            version: 1,
            collection: Collection::Scorecard,
            week: request.week.clone(),
            station: request.station.clone(),
            company_id: api.company_id,
            dsp_code: api.dsp,
            started_at,
            finished_at: now().max(started_at),
            posted,
            datasets,
        };
        capture.validate(request)?;
        Ok(capture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rows_come_as_objects_or_json_strings_for_the_named_dataset() {
        let value = json!({"tableData":{"other":{"rows":[{"week":1}]},
            "dsp_weekly_cdf":{"rows":["{\"week\":38}",{"week":39}]}}});
        assert_eq!(
            rows("dsp_weekly_cdf", &value).unwrap(),
            vec![json!({"week":38}), json!({"week":39})]
        );
        assert!(
            rows("dsp_weekly_cdf", &json!({"tableData":{}}))
                .unwrap()
                .is_empty()
        );
        assert!(rows("x", &json!({"tableData":{"x":{"rows":["not json"]}}})).is_err());
        assert!(rows("x", &json!({"tableData":{"x":{"rows":[1]}}})).is_err());
        assert!(rows("x", &json!({"rows":[]})).is_err());
    }
    #[test]
    fn data_requests_name_the_api_and_this_dsp_on_the_pages_origin_only() {
        let origin = "https://logistics.amazon.com";
        let (base, dsp, station) = data_request(
            "https://logistics.amazon.com/performance/api/v1/getData?dataSetId=x&dsp=FSCL&station=DOT4",
            origin,
        )
        .unwrap();
        assert_eq!(base, "https://logistics.amazon.com/performance/api/v1");
        assert_eq!((dsp.as_str(), station.as_str()), ("FSCL", "DOT4"));
        assert!(
            data_request(
                "https://evil.example/performance/api/v1/getData?dsp=FSCL",
                origin
            )
            .is_err()
        );
        assert!(
            data_request(
                "https://logistics.amazon.com/other/api/v1/getData?dsp=FSCL",
                origin
            )
            .is_err()
        );
        assert!(
            data_request(
                "https://logistics.amazon.com/performance/api/v1/getData",
                origin
            )
            .is_err()
        );
    }
    #[test]
    fn addresses_follow_the_pages_parameter_order() {
        let api = Api {
            base: "https://logistics.amazon.com/performance/api/v1".into(),
            dsp: "FSCL".into(),
            company_id: "company".into(),
        };
        let dataset = crate::scorecard::dataset("da_dsp_station_weekly_performance").unwrap();
        assert_eq!(
            api.address(dataset, "DOT4", "2026-W38", "2026-W38"),
            concat!(
                "https://logistics.amazon.com/performance/api/v1/getData?dataSetId=",
                "da_dsp_station_weekly_performance&dsp=FSCL&from=2026-W38&program=AMZL",
                "&station=DOT4&timeFrame=Weekly&to=2026-W38"
            )
        );
    }
}
