use super::*;
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub provider: String,
    pub enabled: bool,
    pub status: ConnectionStatus,
    pub error: Option<String>,
    pub updated_at: String,
    pub last_verified_at: Option<String>,
    pub account_label: Option<String>,
    /// The browser session a member can take over, while one waits for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub verification_session_id: Option<String>,
}
impl FromRow for Connection {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            provider: row.get("provider")?,
            enabled: row.get("enabled")?,
            status: row.get("status")?,
            error: row.get("error")?,
            updated_at: row.get("updated_at")?,
            last_verified_at: row.get("verified_at")?,
            account_label: row.get("account_label")?,
            verification_session_id: None,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CollectionSchedule {
    pub id: String,
    pub name: String,
    pub collection: ScheduleCollection,
    pub cadence: Cadence,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub interval_minutes: Option<i64>,
    pub local_time: String,
    pub enabled: bool,
    pub next_run: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CollectionSchedules {
    pub timezone: String,
    pub dsp_name: String,
    pub schedules: Vec<CollectionSchedule>,
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    pub next_run: String,
}

/// A bounded collection change hint. Missing history falls back to `all`.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CollectionChange {
    pub provider: String,
    pub dates: Vec<String>,
    pub employee_code: Option<String>,
    pub roster: bool,
}
impl CollectionChange {
    pub fn all() -> Self {
        Self {
            provider: "all".into(),
            dates: vec![],
            employee_code: None,
            roster: true,
        }
    }
    pub fn provider(provider: &str) -> Self {
        Self {
            provider: provider.into(),
            ..Self::all()
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CollectionUpdates {
    pub revision: String,
    pub changes: Vec<CollectionChange>,
}
