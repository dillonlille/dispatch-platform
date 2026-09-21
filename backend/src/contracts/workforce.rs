use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct EmployeeTimecardPeriod {
    pub from: String,
    pub to: String,
}
impl FromRow for EmployeeTimecardPeriod {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            from: row.get("period_from")?,
            to: row.get("period_to")?,
        })
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmployeeTimecardResponse {
    #[cfg_attr(test, ts(type = "unknown"))]
    pub employee: Value,
    #[cfg_attr(test, ts(type = "unknown[]"))]
    pub timecards: Vec<Value>,
    pub period: EmployeeTimecardPeriod,
    pub previous_period: Option<EmployeeTimecardPeriod>,
    pub next_period: Option<EmployeeTimecardPeriod>,
    pub collected_at: Option<String>,
    pub sync_status: Option<JobStatus>,
}
