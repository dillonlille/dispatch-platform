use super::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AssessedClock {
    pub minute: i32,
    pub day: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Lunch {
    pub out: Option<AssessedClock>,
    #[serde(rename = "in")]
    pub clock_in: Option<AssessedClock>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PunchEvent {
    pub kind: String,
    pub time: Option<AssessedClock>,
    pub raw: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PaycomDay {
    pub in_day: Option<AssessedClock>,
    pub out_day: Option<AssessedClock>,
    pub lunches: Vec<Lunch>,
    pub events: Vec<PunchEvent>,
    pub review: bool,
    pub legacy: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DeliveryGap {
    #[cfg_attr(test, ts(type = "number"))]
    pub milliseconds: i64,
    pub over_limit: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DeliveryGaps {
    pub before: Option<DeliveryGap>,
    pub after: Option<DeliveryGap>,
}

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum MealStatus {
        FlexOnly => "flex_only", NoFlexMeal => "no_flex_meal",
        ReviewPunches => "review_punches", MissingLunch => "missing_lunch",
        ReviewPairing => "review_pairing", MissingData => "missing_data",
        Different => "different", Same => "same",
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealPair {
    pub cortex_index: Option<usize>,
    pub lunch_index: Option<usize>,
    pub out: Option<AssessedClock>,
    pub into: Option<AssessedClock>,
    pub out_difference: Option<i32>,
    pub in_difference: Option<i32>,
    pub gaps: DeliveryGaps,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MealAssessment {
    pub paycom: PaycomDay,
    pub pairs: Vec<MealPair>,
    pub different: bool,
    pub missing: bool,
    pub status: MealStatus,
    pub long_gap: bool,
    pub late_in: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LateRule {
    pub time: String,
    pub departments: Vec<String>,
}
