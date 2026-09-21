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
    pub employee: Employee,
    pub timecards: Vec<EmployeeTimecard>,
    pub period: EmployeeTimecardPeriod,
    pub previous_period: Option<EmployeeTimecardPeriod>,
    pub next_period: Option<EmployeeTimecardPeriod>,
    pub collected_at: Option<String>,
    pub sync_status: Option<JobStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Employee {
    pub code: String,
    pub name: String,
    pub department: String,
    pub position: String,
    pub station: String,
    pub active: bool,
}

// Keep absent labels distinct from explicit null labels on partial punches.
fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum InPunchKind { Day => "IN DAY", Lunch => "IN LUNCH", }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum OutPunchKind { Lunch => "OUT LUNCH", Day => "OUT DAY", }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Punch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<InPunchKind>", optional = nullable))]
    pub in_kind: Option<Option<InPunchKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<OutPunchKind>", optional = nullable))]
    pub out_kind: Option<Option<OutPunchKind>>,
    #[serde(rename = "in")]
    pub clock_in: Option<String>,
    #[serde(rename = "out")]
    pub clock_out: Option<String>,
    pub hours: Option<f64>,
}
impl<'de> Deserialize<'de> for Punch {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Input {
            #[serde(default, deserialize_with = "present")]
            in_kind: Option<Option<InPunchKind>>,
            #[serde(default, deserialize_with = "present")]
            out_kind: Option<Option<OutPunchKind>>,
            #[serde(rename = "in")]
            clock_in: Option<String>,
            #[serde(rename = "out")]
            clock_out: Option<String>,
            hours: Option<f64>,
        }
        let input = Input::deserialize(deserializer)?;
        Ok(Self {
            in_kind: input.in_kind,
            out_kind: input.out_kind,
            clock_in: input.clock_in,
            clock_out: input.clock_out,
            hours: input.hours,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Timecard {
    pub employee_code: String,
    pub date: String,
    pub hours: f64,
    pub status: String,
    pub punches: Vec<Punch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmployeeTimecard {
    #[serde(flatten)]
    pub card: Timecard,
    pub assessment: PaycomDay,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DailyTimecard {
    #[serde(flatten)]
    pub card: Timecard,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DailyTimecards {
    pub rows: Vec<DailyTimecard>,
    pub collected_at: Option<String>,
    pub available: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmployeesResponse {
    pub employees: Vec<Employee>,
    pub total: usize,
    pub collected_at: Option<String>,
}
