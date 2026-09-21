use super::*;
use std::collections::BTreeMap;

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum AuditArea {
        Team => "team", Roles => "roles", Collections => "collections", Schedules => "schedules",
        Connections => "connections", Access => "access", Dsps => "dsps", Settings => "settings",
    }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum AuditSubject { Member => "member", Role => "role", Schedule => "schedule", Job => "job", }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AuditReference {
    pub kind: AuditSubject,
    pub id: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AuditChange {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    #[cfg_attr(test, ts(type = "number"))]
    pub id: i64,
    pub at: String,
    pub actor_id: Option<String>,
    pub actor_name: String,
    pub dsp_id: Option<String>,
    pub dsp_name: Option<String>,
    pub action: String,
    pub detail: String,
    pub area: AuditArea,
    pub target: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<AuditReference>,
    pub changes: Vec<AuditChange>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AuditName {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AuditPage {
    pub events: Vec<AuditEvent>,
    #[cfg_attr(test, ts(type = "number"))]
    pub total: i64,
    pub counts: BTreeMap<AuditCount, usize>,
    pub actors: Vec<AuditName>,
    pub dsps: Vec<AuditName>,
}

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    #[derive(PartialOrd, Ord)]
    pub enum AuditCount {
        Team => "team", Roles => "roles", Collections => "collections", Schedules => "schedules",
        Connections => "connections", Access => "access", Dsps => "dsps", Settings => "settings", Failures => "failures",
    }
}
