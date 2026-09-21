use crate::{
    Error, Result,
    collectors::Provider,
    db::{AuditChange, Db, Store, iso, n},
    ensure, validate as v,
};
use serde_json::{Value, json};
use std::collections::HashSet;
const COLUMNS: [&str; 6] = [
    "inDay",
    "outLunch",
    "inLunch",
    "outDay",
    "totalHours",
    "condition",
];
pub fn defaults() -> Value {
    json!({"opening_page":"timecards","rows_per_page":100,"name_order":"first_last",
        "default_sort":"employeeName","department":null,"station":null,"columns":COLUMNS,
        "driver_departments":null,"late_da_time":"10:01","late_da_departments":[]})
}
pub(super) fn preferences(db: &Db) -> Result<Value> {
    let mut stored = db.setting(
        "paycom.preferences",
        json!({"revision":0,"values":defaults(),"history":[]}),
    )?;
    // Preferences saved before a key existed take that key's default.
    for (key, value) in defaults().as_object().unwrap() {
        if stored["values"].get(key).is_none() {
            stored["values"][key] = value.clone();
        }
    }
    without_retired(&mut stored["values"]);
    Ok(stored)
}
// Collection schedules replaced these. Preferences saved through v0.0.9 hold
// them, and a dashboard opened before an update still sends them.
fn without_retired(values: &mut Value) {
    if let Some(values) = values.as_object_mut() {
        values
            .retain(|key, _| !["automatic_sync", "sync_interval_seconds"].contains(&key.as_str()));
    }
}
fn validate_preferences(value: &Value) -> Result<()> {
    v::fields(
        value,
        &[
            "opening_page",
            "rows_per_page",
            "name_order",
            "default_sort",
            "department",
            "station",
            "columns",
            "driver_departments",
            "late_da_time",
            "late_da_departments",
        ],
    )?;
    v::choice(
        value,
        "opening_page",
        &["timecards", "meal-breaks", "employees"],
    )?;
    v::choice(value, "name_order", &["first_last", "last_first"])?;
    v::choice(
        value,
        "default_sort",
        &["employeeName", "condition", "inDay"],
    )?;
    ensure(
        [25, 50, 100].contains(&v::integer(value, "rows_per_page", 1, 100)?),
        "invalid_input",
        400,
    )?;
    for key in ["department", "station"] {
        if !value[key].is_null() {
            v::text(value, key, 0, 200)?;
        }
    }
    let cols = value["columns"]
        .as_array()
        .ok_or_else(|| Error::new("invalid_input", 400))?;
    ensure(
        cols.len() <= 6
            && cols
                .iter()
                .all(|c| c.as_str().is_some_and(|s| COLUMNS.contains(&s)))
            && cols
                .iter()
                .map(Value::to_string)
                .collect::<HashSet<_>>()
                .len()
                == cols.len(),
        "invalid_input",
        400,
    )?;
    for key in ["driver_departments", "late_da_departments"] {
        // Only the Timecard filter distinguishes "all" (null) from "none" (empty).
        if key == "driver_departments" && value[key].is_null() {
            continue;
        }
        ensure(
            value[key].as_array().is_some_and(|a| {
                a.len() <= 500
                    && a.iter()
                        .all(|x| x.as_str().is_some_and(|s| s.chars().count() <= 200))
            }),
            "invalid_input",
            400,
        )?;
    }
    let time = v::text(value, "late_da_time", 5, 5)?.as_bytes();
    ensure(
        time[2] == b':'
            && [0, 1, 3, 4].iter().all(|i| time[*i].is_ascii_digit())
            && (time[0], time[1]) <= (b'2', b'3')
            && time[3] <= b'5',
        "invalid_input",
        400,
    )?;
    Ok(())
}
// The settings a member can change, compared for the audit log. An unset
// filter means "All", and an empty list "None".
fn preference_changes(before: &Value, after: &Value) -> Vec<AuditChange> {
    const FIELDS: [(&str, &str); 10] = [
        ("opening_page", "paycom.opening_page"),
        ("rows_per_page", "paycom.rows_per_page"),
        ("name_order", "paycom.name_order"),
        ("default_sort", "paycom.default_sort"),
        ("department", "paycom.department"),
        ("station", "paycom.station"),
        ("columns", "paycom.columns"),
        ("driver_departments", "paycom.driver_departments"),
        ("late_da_time", "paycom.late_da_time"),
        ("late_da_departments", "paycom.late_da_departments"),
    ];
    let text = |value: &Value| match value {
        Value::Null => "All".to_owned(),
        Value::String(text) => text.clone(),
        Value::Array(items) if items.is_empty() => "None".to_owned(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map_or_else(|| item.to_string(), str::to_owned)
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    };
    FIELDS
        .iter()
        .filter(|(key, _)| before[key] != after[key])
        .map(|(key, field)| (*field, Some(text(&before[key])), Some(text(&after[key]))))
        .collect()
}
impl Store {
    pub fn preferences(&self, id: &str) -> Result<Value> {
        let db = self.collector(id, Provider::Paycom)?;
        let mut out = preferences(&db)?;
        let departments=db.all("SELECT department value,count(*) count FROM employees WHERE \
            publication_id=(SELECT id FROM publications WHERE active=1) GROUP BY department ORDER BY department",[])?;
        let stations: Vec<Value> = db
            .all(
                "SELECT DISTINCT station FROM employees WHERE \
            publication_id=(SELECT id FROM publications WHERE active=1) ORDER BY \
            station",
                [],
            )?
            .into_iter()
            .map(|r| r["station"].clone())
            .collect();
        out["options"] = json!({"departments":departments,"stations":stations});
        Ok(out)
    }
    pub fn save_preferences(
        &self,
        id: &str,
        actor: &str,
        revision: i64,
        values: &Value,
    ) -> Result<Value> {
        let mut values = values.clone();
        without_retired(&mut values);
        let values = &values;
        validate_preferences(values)?;
        let previous = self.preferences(id)?;
        let db = self.collector(id, Provider::Paycom)?;
        db.transaction(|| {
            let before = preferences(&db)?;
            ensure(
                n(&before, "revision") == revision,
                "settings_changed_reload_before_saving",
                409,
            )?;
            let mut history =
                vec![json!({"revision":before["revision"],"at":iso(),"values":before["values"]})];
            history.extend(before["history"].as_array().cloned().unwrap_or_default());
            history.truncate(20);
            db.set(
                "paycom.preferences",
                &json!({"revision":revision+1,"values":values,"history":history}),
            )
        })?;
        self.audit_with(
            Some(actor),
            Some(id),
            "paycom.settings_updated",
            &format!("Revision {}", revision + 1),
            None,
            &preference_changes(&previous["values"], values),
        )?;
        self.preferences(id)
    }
}
