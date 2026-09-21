use super::validation::{sources, validate_workforce};
use crate::{
    Result,
    collectors::Provider,
    crypto,
    db::{Store, flag, s},
};
use rusqlite::params;
use serde_json::{Value, json};
impl Store {
    pub fn publish(&self, id: &str, value: &Value) -> Result<Value> {
        validate_workforce(value)?;
        let db = self.collector(id, Provider::Paycom)?;
        let mut employees = value["employees"].as_array().unwrap().clone();
        employees.sort_by(|a, b| s(a, "code").cmp(s(b, "code")));
        let mut timecards = value["timecards"].as_array().unwrap().clone();
        timecards.sort_by(|a, b| {
            (s(a, "employeeCode"), s(a, "date")).cmp(&(s(b, "employeeCode"), s(b, "date")))
        });
        // Links are part of the fingerprint so a collection whose hours did not
        // change still publishes them; payloads without links keep their digest.
        let mut sources = sources(value).to_vec();
        sources.sort_by(|a, b| s(a, "employeeCode").cmp(s(b, "employeeCode")));
        let mut fingerprint = json!({"from":value["from"],"to":value["to"],"employees":employees,"timecards":timecards});
        if !sources.is_empty() {
            fingerprint["sources"] = json!(sources);
        }
        let fingerprint = crypto::sha(serde_json::to_vec(&fingerprint)?);
        db.transaction(|| {
            let previous = db.setting("paycom.publicationFingerprint", Value::Null)?;
            if s(&previous, "digest") == fingerprint {
                let updated = db.exec(
                    "UPDATE publications SET collected_at=? WHERE id=? AND \
                    active=1 AND collected_at<=?",
                    [
                        s(value, "collectedAt"),
                        s(&previous, "id"),
                        s(value, "collectedAt"),
                    ],
                )?;
                if updated == 1 {
                    return Ok(());
                }
            }
            let publication = crypto::id("pub")?;
            db.exec(
                "INSERT INTO publications(id,collected_at,period_from,period_to) VALUES (?,?,?,?)",
                [
                    &publication,
                    s(value, "collectedAt"),
                    s(value, "from"),
                    s(value, "to"),
                ],
            )?;
            for e in value["employees"].as_array().unwrap() {
                db.exec(
                    "INSERT INTO employees VALUES (?,?,?,?,?,?,?)",
                    params![
                        publication,
                        s(e, "code"),
                        s(e, "name"),
                        s(e, "department"),
                        s(e, "position"),
                        s(e, "station"),
                        flag(e, "active")
                    ],
                )?;
            }
            for t in value["timecards"].as_array().unwrap() {
                db.exec(
                    "INSERT INTO timecards VALUES (?,?,?,?,?,?)",
                    params![
                        publication,
                        s(t, "employeeCode"),
                        s(t, "date"),
                        t["hours"].as_f64(),
                        s(t, "status"),
                        t["punches"].to_string()
                    ],
                )?;
            }
            for source in &sources {
                db.exec(
                    "INSERT INTO timecard_sources VALUES (?,?,?,?)",
                    params![
                        publication,
                        s(source, "employeeCode"),
                        s(source, "periodKey"),
                        s(source, "url")
                    ],
                )?;
            }
            db.exec("UPDATE publications SET active=0 WHERE active=1", [])?;
            db.exec(
                "UPDATE publications SET active=1 WHERE id=?",
                [&publication],
            )?;
            db.set(
                "paycom.publicationFingerprint",
                &json!({"id":publication,"digest":fingerprint}),
            )?;
            Ok(())
        })?;
        Ok(
            json!({"employees":value["employees"].as_array().unwrap().len(),
                "timecards":value["timecards"].as_array().unwrap().len(),"collectedAt":value["collectedAt"]}),
        )
    }
}
