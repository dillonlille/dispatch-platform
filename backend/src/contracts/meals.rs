use super::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CortexMeal {
    pub meal_id: String,
    pub itinerary_id: String,
    pub cortex_id: String,
    pub driver_name: String,
    pub station: String,
    pub timezone: String,
    pub collected_at: String,
    pub last_delivery: Option<String>,
    pub start: String,
    pub end: Option<String>,
    pub first_delivery: Option<String>,
    pub before_status: String,
    pub after_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealPaycom {
    pub employee_code: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub department: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub station: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub hours: Option<f64>,
    pub status: String,
    pub punches: Vec<Punch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealSource {
    pub id: String,
    pub name: String,
    pub paycom: Option<MealPaycom>,
    pub cortex: Vec<CortexMeal>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealEmployee {
    #[serde(flatten)]
    pub source: MealSource,
    pub assessment: MealAssessment,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmployeeLink {
    pub id: String,
    pub cortex_id: String,
    pub paycom_code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EmployeeLinks {
    pub revision: u32,
    pub links: Vec<EmployeeLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub separate: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealRosterEmployee {
    pub code: String,
    pub name: String,
}

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum MatchType { Name => "name", Saved => "saved", Separate => "separate", Unmatched => "unmatched", }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealDriver {
    pub id: String,
    pub name: String,
    pub paycom_code: Option<String>,
    pub match_type: MatchType,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CortexPublication {
    pub station: String,
    pub timezone: String,
    pub collected_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub service_area_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional = nullable))]
    pub provider: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealComparison {
    pub date: String,
    pub timezone: String,
    pub rows: Vec<MealEmployee>,
    pub paycom_collected_at: Option<String>,
    pub cortex_publications: Vec<CortexPublication>,
    pub employees: Vec<MealRosterEmployee>,
    pub drivers: Vec<MealDriver>,
    pub links: EmployeeLinks,
}
