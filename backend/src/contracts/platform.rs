use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BrowserAdmission {
    #[cfg_attr(test, ts(type = "number | null"))]
    pub available_bytes: Option<u64>,
    #[cfg_attr(test, ts(type = "number"))]
    pub required_bytes: u64,
    pub can_start: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BrowserHealth {
    pub active: usize,
    pub capacity: usize,
    pub memory: BrowserAdmission,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TransportHealth {
    pub error: Option<String>,
    pub checked_at: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MailHealth {
    pub enabled: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub pending: i64,
    #[cfg_attr(test, ts(type = "number"))]
    pub failed: i64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub oldest_pending_age_ms: Option<i64>,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub transport: TransportHealth,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlatformHealth {
    pub environment: Environment,
    pub release: String,
    pub jobs: BTreeMap<JobStatus, u32>,
    pub browsers: BrowserHealth,
    #[cfg_attr(test, ts(type = "number"))]
    pub dsps: i64,
    pub email: bool,
    pub mail: MailHealth,
    pub provider_mode: ProviderMode,
}
