use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum JobPhase {
    Starting,
    Authentication,
    Verification,
    Collection,
    Publication,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct JobMetrics {
    #[cfg_attr(test, ts(type = "number"))]
    pub attempt: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: JobOutcome,
    pub error: Option<String>,
    pub phase: Option<JobPhase>,
    pub detail: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub queue_ms: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub elapsed_ms: u64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub authentication_ms: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub verification_ms: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub collection_ms: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub publication_ms: Option<u64>,
    pub employees: Option<usize>,
    pub timecards: Option<usize>,
    pub itineraries: Option<usize>,
    pub meals: Option<usize>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub peak_rss_bytes: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub peak_pss_bytes: Option<u64>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub peak_private_bytes: Option<u64>,
    #[cfg_attr(test, ts(type = "number"))]
    pub memory_samples: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub incomplete_memory_samples: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub page_reads: Option<PageReads>,
}
// Keep diagnostics bounded even for the maximum 5,000-employee roster. Ordinals
// identify progress without persisting employee codes, URLs or provider content.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PageReads {
    pub completed: usize,
    pub retries: usize,
    pub recovered: usize,
    #[serde(default)]
    pub resumed: usize,
    #[serde(default)]
    pub early_ready: usize,
    #[serde(default)]
    pub direct: usize,
    #[serde(default)]
    pub spot_checked: usize,
    #[cfg_attr(test, ts(type = "number"))]
    pub total_ms: u64,
    pub active: Vec<PageRead>,
    pub slowest: Vec<PageRead>,
    pub failures: Vec<PageRead>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PageRead {
    pub ordinal: usize,
    pub attempt: usize,
    pub stage: PageStage,
    #[cfg_attr(test, ts(type = "number"))]
    pub elapsed_ms: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub navigation_ms: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub content_ms: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub extraction_ms: u64,
    pub error: Option<String>,
    pub pending_requests: Option<usize>,
    pub document_state: Option<DocumentState>,
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum JobOutcome {
        Running => "running", Succeeded => "succeeded", Failed => "failed",
        Cancelled => "cancelled", Interrupted => "interrupted",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum PageStage { Navigation => "navigation", Content => "content", Extraction => "extraction", }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum DocumentState { Loading => "loading", Interactive => "interactive", Complete => "complete", }
}
