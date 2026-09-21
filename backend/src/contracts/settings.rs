use super::*;

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum NameOrder { FirstLast => "first_last", LastFirst => "last_first", }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum PaycomPage { Timecards => "timecards", Meals => "meal-breaks", Employees => "employees", }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum PaycomSort { EmployeeName => "employeeName", Condition => "condition", InDay => "inDay", }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum PaycomColumn {
        InDay => "inDay", OutLunch => "outLunch", InLunch => "inLunch",
        OutDay => "outDay", TotalHours => "totalHours", Condition => "condition",
    }
}
/// Historical revisions inherit defaults for fields introduced after they were saved.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default)]
pub struct PaycomPreferences {
    pub opening_page: PaycomPage,
    pub rows_per_page: u32,
    pub name_order: NameOrder,
    pub default_sort: PaycomSort,
    pub department: Option<String>,
    pub station: Option<String>,
    pub columns: Vec<PaycomColumn>,
    pub driver_departments: Option<Vec<String>>,
    pub late_da_time: String,
    pub late_da_departments: Vec<String>,
}
impl Default for PaycomPreferences {
    fn default() -> Self {
        Self {
            opening_page: PaycomPage::Timecards,
            rows_per_page: 100,
            name_order: NameOrder::FirstLast,
            default_sort: PaycomSort::EmployeeName,
            department: None,
            station: None,
            columns: vec![
                PaycomColumn::InDay,
                PaycomColumn::OutLunch,
                PaycomColumn::InLunch,
                PaycomColumn::OutDay,
                PaycomColumn::TotalHours,
                PaycomColumn::Condition,
            ],
            driver_departments: None,
            late_da_time: "10:01".into(),
            late_da_departments: vec![],
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PreferenceRevision {
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub at: String,
    pub values: PaycomPreferences,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DepartmentOption {
    pub value: String,
    pub count: usize,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaycomOptions {
    pub departments: Vec<DepartmentOption>,
    pub stations: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaycomSettings {
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub values: PaycomPreferences,
    pub history: Vec<PreferenceRevision>,
    pub options: PaycomOptions,
}
