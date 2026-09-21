use super::{compare, display_name, preferences::preferences};
use crate::{
    Result,
    collectors::Provider,
    db::{Db, Store, s},
    validate as v,
};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::BTreeMap;
fn visible(row: &Value, p: &Value, drivers: bool) -> bool {
    ["department", "station"]
        .iter()
        .all(|key| p[*key].is_null() || s(p, key).is_empty() || row[*key] == p[*key])
        && (!drivers
            || p["driver_departments"].is_null()
            || p["driver_departments"]
                .as_array()
                .is_some_and(|a| a.contains(&row["department"])))
}
pub(crate) fn cards(db: &Db, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut rows = db.all(sql, p)?;
    for row in &mut rows {
        row["punches"] = serde_json::from_str(s(row, "punches"))?;
    }
    Ok(rows)
}
impl Store {
    /// Overlay only completed employee pages from the current guarded attempt.
    pub fn daily_source(
        &self,
        id: &str,
        date: &str,
    ) -> Result<(Option<Value>, Vec<Value>, Vec<Value>)> {
        let db = self.collector(id, Provider::Paycom)?;
        let publication = db.one(
            "SELECT id,collected_at FROM publications WHERE \
            period_from<=? AND period_to>=? ORDER BY collected_at DESC,id DESC LIMIT 1",
            [date, date],
        )?;
        let mut roster = BTreeMap::new();
        let mut rows = BTreeMap::new();
        if let Some(p) = &publication {
            for employee in db.all(
                "SELECT code,name FROM employees WHERE publication_id=?",
                [s(p, "id")],
            )? {
                roster.insert(s(&employee, "code").to_owned(), employee);
            }
            for row in cards(
                &db,
                "SELECT t.employee_code \
                    employeeCode,e.name,e.department,e.station,t.date,t.hours,t.status,t.punches,u.url \
                sourceUrl FROM timecards t JOIN employees e ON e.publication_id=t.publication_id AND \
                e.code=t.employee_code LEFT JOIN timecard_sources u ON u.publication_id=t.publication_id AND \
                u.employee_code=t.employee_code WHERE t.publication_id=? AND t.date=?",
                [s(p, "id"), date],
            )? {
                rows.insert(s(&row, "employeeCode").to_owned(), row);
            }
        }
        // A completed employee sync overlays only that employee, and only until
        // a newer full collection supersedes it.
        for sync in db.all(
            "SELECT data FROM employee_timecard_syncs WHERE period_from<=? AND period_to>=? \
             AND collected_at>=? ORDER BY collected_at,employee_code",
            params![
                date,
                date,
                publication.as_ref().map_or("", |p| s(p, "collected_at"))
            ],
        )? {
            let data: Value = serde_json::from_str(s(&sync, "data"))?;
            let employee = &data["employees"][0];
            let code = s(employee, "code");
            roster.insert(code.into(), json!({"code":code,"name":employee["name"]}));
            if let Some(mut card) = crate::workforce::sync::synced_cards(&data)
                .into_iter()
                .find(|card| card["date"] == date)
            {
                for key in ["name", "department", "station"] {
                    card[key] = employee[key].clone();
                }
                rows.insert(code.into(), card);
            }
        }
        for (metadata, items) in self.live_results(id, Provider::Paycom, date)? {
            for employee in metadata["roster"].as_array().into_iter().flatten() {
                roster.insert(
                    s(employee, "code").to_owned(),
                    json!({"code":employee["code"],"name":employee["name"]}),
                );
            }
            for row in items {
                rows.insert(s(&row, "employeeCode").to_owned(), row);
            }
        }
        Ok((
            publication,
            roster.into_values().collect(),
            rows.into_values().collect(),
        ))
    }
    pub fn daily(&self, id: &str, date: &str, sort: &str, desc: bool) -> Result<Value> {
        v::date(date)?;
        let db = self.collector(id, Provider::Paycom)?;
        let settings = preferences(&db)?;
        let p = &settings["values"];
        let (publication, _, mut rows) = self.daily_source(id, date)?;
        let available = publication.is_some() || !rows.is_empty();
        rows.retain(|r| visible(r, p, true));
        for row in &mut rows {
            row["name"] = json!(display_name(s(row, "name"), s(p, "name_order")));
            row.as_object_mut().unwrap().remove("department");
            row.as_object_mut().unwrap().remove("station");
        }
        rows.sort_by(|a, b| {
            let x = sort_key(a, sort);
            let y = sort_key(b, sort);
            let ord = if x.is_number() {
                x.as_f64()
                    .unwrap_or(0.)
                    .total_cmp(&y.as_f64().unwrap_or(0.))
            } else {
                compare(x.as_str().unwrap_or(""), y.as_str().unwrap_or(""))
            };
            (if desc { ord.reverse() } else { ord })
                .then_with(|| compare(s(a, "employeeCode"), s(b, "employeeCode")))
        });
        Ok(
            json!({"rows":rows,"collectedAt":publication.map(|p|p["collected_at"].clone()),"available":available}),
        )
    }
}
fn sort_key<'a>(row: &'a Value, sort: &str) -> &'a Value {
    let p = row["punches"].as_array();
    match sort {
        "name" => &row["name"],
        "hours" | "totalHours" => &row["hours"],
        "condition" => &row["status"],
        "inDay" => p
            .and_then(|p| p.first())
            .map(|r| &r["in"])
            .unwrap_or(&Value::Null),
        "outDay" => p
            .and_then(|p| p.last())
            .map(|r| &r["out"])
            .unwrap_or(&Value::Null),
        "outLunch" if p.is_some_and(|p| p.len() > 1) => &row["punches"][0]["out"],
        "inLunch" if p.is_some_and(|p| p.len() > 1) => &row["punches"][1]["in"],
        _ => &Value::Null,
    }
}
