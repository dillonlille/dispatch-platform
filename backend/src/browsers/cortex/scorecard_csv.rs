//! The spreadsheet a scorecard page downloads, when its dataset could not be read
//! from the API: the page is opened for the week, its table's column templates are
//! read from the application's props, its download is pressed, and the spreadsheet
//! the page builds is taken from the blob it hands the browser.
use super::{collection::CONTENT_NOT_READY, *};
use crate::{
    job_metrics::Recorder,
    scorecard::{DatasetCapture, Request, Source, csv},
};
use base64::{Engine, engine::general_purpose::STANDARD};

const PAGE: &str = include_str!("scorecard_page.js");
/// The layout the pages show their toolbar in; at the window's 1024 px they fold
/// it into a menu.
const VIEWPORT: (u32, u32) = (1600, 1000);

/// Where a dataset's page is.
pub(super) struct Page {
    pub page_id: &'static str,
    pub tab_id: &'static str,
}

impl Driver {
    async fn page_script(&self, input: &Value, metrics: &Recorder) -> Result<Value> {
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
        let result = self
            .browser
            .evaluate(&self.page.id, &call(PAGE, input))
            .await?;
        if let Some(error) = result["error"].as_str() {
            metrics.detail(s(&result, "reason"));
            let allowed = [
                crate::Code::CortexScopeMismatch,
                crate::Code::CortexContentIncomplete,
                crate::Code::CortexSourceTooLarge,
                crate::Code::ScorecardWeekUnavailable,
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
    /// The dataset's rows from its page's spreadsheet.
    pub(super) async fn download_dataset(
        &self,
        request: &Request,
        company_id: &str,
        dataset: &crate::scorecard::Dataset,
        page: &Page,
        run: &Run<'_>,
    ) -> Result<DatasetCapture> {
        let metrics = run.metrics;
        let source_url = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query
                .append_pair("pageId", page.page_id)
                .append_pair("station", &request.station)
                .append_pair("companyId", company_id)
                .append_pair("tabId", page.tab_id)
                .append_pair("timeFrame", "Weekly")
                .append_pair("to", &request.week);
            format!("{}/performance?{}", self.origin, query.finish())
        };
        let action = |name: &str| {
            let mut input = json!({"action":name,"origin":self.origin,"pageId":page.page_id,
                "station":request.station,"week":request.week});
            input["action"] = json!(name);
            input
        };
        let (from, to) = request.interval(dataset)?;
        self.page
            .command(
                "Emulation.setDeviceMetricsOverride",
                json!({"width":VIEWPORT.0,"height":VIEWPORT.1,"deviceScaleFactor":1,"mobile":false}),
            )
            .await?;
        let result = self.download(&source_url, &action, metrics, run).await;
        // Leave the tab as the other collections expect it.
        let _ = self
            .page
            .command("Emulation.clearDeviceMetricsOverride", json!({}))
            .await;
        let rows = result?;
        Ok(DatasetCapture {
            id: dataset.id.into(),
            from,
            to,
            source_url,
            source: Source::Csv,
            rows,
        })
    }
    async fn download(
        &self,
        source_url: &str,
        action: &(dyn Fn(&str) -> Value + Sync),
        metrics: &Recorder,
        run: &Run<'_>,
    ) -> Result<Vec<Value>> {
        // The new document must have committed before its props are read; otherwise
        // the previous page answers with its own week and scope.
        let previous = self.page.start_navigation(source_url).await?;
        let committed = Instant::now() + Duration::from_secs(30);
        while self.page.navigation(&previous).await?.is_null() {
            ensure(Instant::now() < committed, "cortex_content_incomplete", 502)?;
            sleep(Duration::from_millis(200)).await;
        }
        // Until the table and its download are there. A page that never shows them
        // is not read as empty: an empty week's page cannot be told from a failed one.
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut polls = 0u32;
        let templates: Vec<String> = loop {
            sleep(Duration::from_millis(500)).await;
            polls += 1;
            if polls.is_multiple_of(10) {
                // Keeps the job's lease and notices a cancellation.
                run.progress(run_progress(), "Reading a scorecard page".into())
                    .await?;
            }
            match self.page_script(&action("survey"), metrics).await {
                Ok(state) if state["ready"] == true => {
                    break state["templates"]
                        .as_array()
                        .map(|t| {
                            t.iter()
                                .map(|v| v.as_str().unwrap_or("").to_owned())
                                .collect()
                        })
                        .unwrap_or_default();
                }
                Ok(_) => (),
                Err(error) if error.is_any(CONTENT_NOT_READY) => (),
                Err(error) => return Err(error),
            }
            ensure(Instant::now() < deadline, "cortex_content_incomplete", 502)?;
        };
        self.page_script(&action("hook"), metrics).await?;
        self.page_script(&action("press"), metrics).await?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let text = loop {
            sleep(Duration::from_millis(500)).await;
            let downloads = self.page_script(&action("downloads"), metrics).await?;
            let spreadsheet = downloads["downloads"].as_array().and_then(|list| {
                list.iter()
                    .find(|d| s(d, "type").to_ascii_lowercase().contains("csv"))
            });
            if let Some(spreadsheet) = spreadsheet {
                ensure(
                    spreadsheet["tooLarge"] != true,
                    "scorecard_source_too_large",
                    502,
                )?;
                if let Some(base64) = spreadsheet["base64"].as_str() {
                    let bytes = STANDARD
                        .decode(base64)
                        .map_err(|_| Error::new("scorecard_csv_invalid", 502))?;
                    break String::from_utf8(bytes)
                        .map_err(|_| Error::new("scorecard_csv_invalid", 502))?;
                }
            }
            ensure(Instant::now() < deadline, "cortex_content_incomplete", 502)?;
        };
        let rows = csv::rows(&text, &templates)?;
        ensure(
            rows.len() <= crate::scorecard::MAX_ROWS,
            "scorecard_source_too_large",
            502,
        )?;
        metrics.detail("csv_fallback");
        Ok(rows)
    }
}
/// The progress a page read shows: the datasets' share of the job.
fn run_progress() -> i64 {
    50
}
