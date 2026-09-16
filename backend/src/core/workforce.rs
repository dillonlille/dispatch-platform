use super::collectors::Provider;
use super::{
    Error, Result, crypto,
    db::{Db, Store, at, boolean, flag, iso, n, now, s},
    ensure, validate as v,
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::HashSet};
const COLUMNS: [&str; 6] = [
    "inDay",
    "outLunch",
    "inLunch",
    "outDay",
    "totalHours",
    "condition",
];
pub fn defaults() -> Value {
    json!({"automatic_sync":true,"sync_interval_seconds":3600,"opening_page":"timecards","rows_per_page":100,"name_order":"first_last","default_sort":"employeeName","department":null,"station":null,"columns":COLUMNS,"driver_departments":null})
}
fn preferences(db: &Db) -> Result<Value> {
    let mut stored = db.setting(
        "paycom.preferences",
        json!({"revision":0,"values":defaults(),"history":[]}),
    )?;
    stored["values"]["automatic_sync"] = json!(
        db.one("SELECT enabled FROM schedules WHERE provider='paycom'", [])?
            .is_some_and(|r| flag(&r, "enabled"))
    );
    Ok(stored)
}
fn validate_preferences(value: &Value) -> Result<()> {
    v::fields(
        value,
        &[
            "automatic_sync",
            "sync_interval_seconds",
            "opening_page",
            "rows_per_page",
            "name_order",
            "default_sort",
            "department",
            "station",
            "columns",
            "driver_departments",
        ],
    )?;
    v::boolean(value, "automatic_sync")?;
    ensure(
        [1800, 3600, 7200, 14400].contains(&v::integer(value, "sync_interval_seconds", 1, 14400)?),
        "invalid_input",
        400,
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
    if !value["driver_departments"].is_null() {
        ensure(
            value["driver_departments"].as_array().is_some_and(|a| {
                a.len() <= 500
                    && a.iter()
                        .all(|x| x.as_str().is_some_and(|s| s.chars().count() <= 200))
            }),
            "invalid_input",
            400,
        )?;
    }
    Ok(())
}
pub(crate) fn display_name(name: &str, order: &str) -> String {
    let parts: Vec<_> = name
        .split(|c: char| c.is_whitespace() && c != '\u{0085}' || c == '\u{feff}')
        .filter(|s| !s.is_empty())
        .collect();
    if order == "last_first" && parts.len() > 1 {
        format!(
            "{}, {}",
            parts.last().unwrap(),
            parts[..parts.len() - 1].join(" ")
        )
    } else {
        name.into()
    }
}
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
pub(crate) fn compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: std::sync::OnceLock<icu_collator::CollatorBorrowed<'static>> =
        std::sync::OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled Unicode collation data")
        })
        .compare(a, b)
}

fn cards(db: &Db, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut rows = db.all(sql, p)?;
    for row in &mut rows {
        row["punches"] = serde_json::from_str(s(row, "punches"))?;
    }
    Ok(rows)
}
impl Store {
    pub fn preferences(&self, id: &str) -> Result<Value> {
        let db = self.collector(id, Provider::Paycom)?;
        let mut out = preferences(&db)?;
        let departments=db.all("SELECT department value,count(*) count FROM employees WHERE publication_id=(SELECT id FROM publications WHERE active=1) GROUP BY department ORDER BY department",[])?;
        let stations:Vec<Value>=db.all("SELECT DISTINCT station FROM employees WHERE publication_id=(SELECT id FROM publications WHERE active=1) ORDER BY station",[])?.into_iter().map(|r|r["station"].clone()).collect();
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
        validate_preferences(values)?;
        let db = self.collector(id, Provider::Paycom)?;
        db.transaction(|| {
            let before = preferences(&db)?;
            ensure(
                n(&before, "revision") == revision,
                "settings_changed_reload_before_saving",
                409,
            )?;
            let enabled = db
                .one(
                    "SELECT enabled FROM connections WHERE provider='paycom'",
                    [],
                )?
                .is_some_and(|r| flag(&r, "enabled"));
            ensure(
                !flag(values, "automatic_sync") || enabled,
                "connect_paycom_before_automatic_sync",
                409,
            )?;
            let mut history =
                vec![json!({"revision":before["revision"],"at":iso(),"values":before["values"]})];
            history.extend(before["history"].as_array().cloned().unwrap_or_default());
            history.truncate(20);
            db.set(
                "paycom.preferences",
                &json!({"revision":revision+1,"values":values,"history":history}),
            )?;
            let changed = db
                .setting("paycom.syncIntervalSeconds", Value::Null)?
                .is_null()
                || before["values"]["automatic_sync"] != values["automatic_sync"]
                || before["values"]["sync_interval_seconds"] != values["sync_interval_seconds"];
            db.set(
                "paycom.syncIntervalSeconds",
                &values["sync_interval_seconds"],
            )?;
            if changed {
                db.exec(
                    "UPDATE schedules SET enabled=?,next_run=? WHERE provider='paycom'",
                    params![
                        flag(values, "automatic_sync"),
                        if flag(values, "automatic_sync") {
                            Some(at(now() + n(values, "sync_interval_seconds") * 1000))
                        } else {
                            None
                        }
                    ],
                )?;
            }
            Ok(())
        })?;
        self.audit(
            Some(actor),
            Some(id),
            "paycom.settings_updated",
            &format!("Revision {}", revision + 1),
        )?;
        self.preferences(id)
    }
    pub fn publish(&self, id: &str, value: &Value) -> Result<Value> {
        validate_workforce(value)?;
        let db = self.collector(id, Provider::Paycom)?;
        db.transaction(|| {
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
            db.exec("UPDATE publications SET active=0 WHERE active=1", [])?;
            db.exec(
                "UPDATE publications SET active=1 WHERE id=?",
                [&publication],
            )?;
            Ok(())
        })?;
        Ok(
            json!({"employees":value["employees"].as_array().unwrap().len(),"timecards":value["timecards"].as_array().unwrap().len(),"collectedAt":value["collectedAt"]}),
        )
    }
    pub fn employees(
        &self,
        id: &str,
        query: &str,
        offset: usize,
        limit: usize,
        desc: bool,
    ) -> Result<Value> {
        let db = self.collector(id, Provider::Paycom)?;
        let settings = preferences(&db)?;
        let p = &settings["values"];
        let Some(publication) = db.one(
            "SELECT id,collected_at FROM publications WHERE active=1",
            [],
        )?
        else {
            return Ok(json!({"employees":[],"total":0,"collectedAt":null}));
        };
        let publication_id = s(&publication, "id");
        let direction = if desc { "DESC" } else { "ASC" };
        let condition = "publication_id=?1 AND (?2='' OR department=?2) AND (?3='' OR station=?3) AND (?4='' OR instr(dispatch_lower(dispatch_name(name,?5)||' '||code),?4)>0)";
        let total = db
            .one(
                &format!("SELECT count(*) n FROM employees WHERE {condition}"),
                params![
                    publication_id,
                    s(p, "department"),
                    s(p, "station"),
                    query.to_lowercase(),
                    s(p, "name_order")
                ],
            )?
            .unwrap()["n"]
            .clone();
        let mut rows=db.all(&format!("SELECT code,dispatch_name(name,?5) name,department,position,station,active FROM employees WHERE {condition} ORDER BY name COLLATE dispatch_unicode {direction},code COLLATE dispatch_unicode {direction} LIMIT ?6 OFFSET ?7"),params![publication_id,s(p,"department"),s(p,"station"),query.to_lowercase(),s(p,"name_order"),limit as i64,offset as i64])?;
        for row in &mut rows {
            boolean(row, &["active"]);
        }
        Ok(json!({"employees":rows,"total":total,"collectedAt":publication["collected_at"]}))
    }
    pub fn employee(&self, id: &str, code: &str) -> Result<Value> {
        v::code(code)?;
        let db = self.collector(id, Provider::Paycom)?;
        let settings = preferences(&db)?;
        let mut row=db.one("SELECT e.* FROM employees e JOIN publications p ON p.id=e.publication_id WHERE e.code=? ORDER BY p.collected_at DESC LIMIT 1",[code])?.ok_or_else(||Error::new("employee_not_found",404))?;
        let timecards = cards(
            &db,
            "SELECT employee_code employeeCode,date,hours,status,punches FROM timecards WHERE publication_id=? AND employee_code=? ORDER BY date DESC",
            [s(&row, "publication_id"), code],
        )?;
        row.as_object_mut().unwrap().remove("publication_id");
        boolean(&mut row, &["active"]);
        row["name"] = json!(display_name(
            s(&row, "name"),
            s(&settings["values"], "name_order")
        ));
        Ok(json!({"employee":row,"timecards":timecards}))
    }
    pub fn daily(&self, id: &str, date: &str, sort: &str, desc: bool) -> Result<Value> {
        v::date(date)?;
        let db = self.collector(id, Provider::Paycom)?;
        let settings = preferences(&db)?;
        let p = &settings["values"];
        let Some(publication)=db.one("SELECT id,collected_at FROM publications WHERE period_from<=? AND period_to>=? ORDER BY collected_at DESC LIMIT 1",[date,date])? else {return Ok(json!({"rows":[],"collectedAt":null,"available":false}));};
        let mut rows = cards(
            &db,
            "SELECT t.employee_code employeeCode,e.name,e.department,e.station,t.date,t.hours,t.status,t.punches FROM timecards t JOIN employees e ON e.publication_id=t.publication_id AND e.code=t.employee_code WHERE t.publication_id=? AND t.date=?",
            [s(&publication, "id"), date],
        )?;
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
        Ok(json!({"rows":rows,"collectedAt":publication["collected_at"],"available":true}))
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
pub fn validate_workforce(value: &Value) -> Result<()> {
    v::fields(
        value,
        &["employees", "timecards", "collectedAt", "from", "to"],
    )?;
    v::date(s(value, "from"))?;
    v::date(s(value, "to"))?;
    ensure(s(value, "from") <= s(value, "to"), "invalid_period", 400)?;
    ensure(
        chrono::DateTime::parse_from_rfc3339(s(value, "collectedAt")).is_ok(),
        "invalid_collection_time",
        400,
    )?;
    let employees = value["employees"]
        .as_array()
        .ok_or_else(|| Error::new("invalid_workforce", 400))?;
    let timecards = value["timecards"]
        .as_array()
        .ok_or_else(|| Error::new("invalid_workforce", 400))?;
    ensure(
        employees.len() <= 5000 && timecards.len() <= 160000,
        "invalid_workforce",
        400,
    )?;
    let mut codes = HashSet::new();
    for e in employees {
        v::fields(
            e,
            &[
                "code",
                "name",
                "department",
                "position",
                "station",
                "active",
            ],
        )?;
        v::code(s(e, "code"))?;
        v::text(e, "name", 1, 200)?;
        for k in ["department", "position", "station"] {
            v::text(e, k, 0, 200)?;
        }
        v::boolean(e, "active")?;
        ensure(codes.insert(s(e, "code")), "duplicate_employee", 400)?;
    }
    let mut days = HashSet::new();
    for t in timecards {
        v::fields(t, &["employeeCode", "date", "hours", "status", "punches"])?;
        v::date(s(t, "date"))?;
        v::text(t, "status", 0, 200)?;
        ensure(
            t["hours"]
                .as_f64()
                .is_some_and(|h| (0.0..=48.0).contains(&h)),
            "invalid_hours",
            400,
        )?;
        ensure(
            codes.contains(s(t, "employeeCode"))
                && s(t, "date") >= s(value, "from")
                && s(t, "date") <= s(value, "to"),
            "timecard_identity_mismatch",
            400,
        )?;
        ensure(
            days.insert((s(t, "employeeCode"), s(t, "date"))),
            "duplicate_timecard",
            400,
        )?;
        let punches = t["punches"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_punches", 400))?;
        ensure(punches.len() <= 64, "invalid_punches", 400)?;
        for p in punches {
            v::fields(p, &["in", "out", "hours", "inKind", "outKind"])?;
            for (key, kinds) in [
                ("inKind", ["IN DAY", "IN LUNCH"]),
                ("outKind", ["OUT LUNCH", "OUT DAY"]),
            ] {
                if !p[key].is_null() {
                    v::choice(p, key, &kinds)?;
                }
            }
            for k in ["in", "out"] {
                if !p[k].is_null() {
                    v::text(p, k, 0, 64)?;
                }
            }
            ensure(
                p["hours"].is_null()
                    || p["hours"]
                        .as_f64()
                        .is_some_and(|h| (0.0..=48.0).contains(&h)),
                "invalid_hours",
                400,
            )?;
        }
    }
    Ok(())
}
/// A missing date preserves scheduled/current-period collection behavior.
pub fn collection_date(request: &Value, timezone: &str) -> Result<Option<chrono::NaiveDate>> {
    v::fields(request, &["date"])?;
    let Some(value) = request.get("date") else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| Error::new("invalid_date", 400))?;
    let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| Error::new("invalid_date", 400))?;
    let tz: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| Error::new("invalid_timezone", 400))?;
    ensure(
        date.to_string() == value
            && value >= "2000-01-01"
            && date <= chrono::Utc::now().with_timezone(&tz).date_naive(),
        "invalid_date",
        400,
    )?;
    Ok(Some(date))
}
pub fn fixture(timezone: &str) -> Result<Value> {
    fixture_date(timezone, None)
}
pub fn fixture_date(timezone: &str, selected: Option<chrono::NaiveDate>) -> Result<Value> {
    let tz: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| Error::new("invalid_timezone", 400))?;
    let today = selected.unwrap_or_else(|| chrono::Utc::now().with_timezone(&tz).date_naive());
    let dates: Vec<_> = (0..7)
        .map(|i| (today - chrono::Duration::days(6 - i)).to_string())
        .collect();
    let names = [
        "Avery Morgan",
        "Jordan Ellis",
        "Morgan Reed",
        "Taylor Brooks",
        "Cameron Hayes",
        "Casey Rivera",
        "Riley Bennett",
        "Alex Parker",
        "Jamie Collins",
        "Drew Sullivan",
        "Sam Mitchell",
        "Quinn Foster",
    ];
    let employees:Vec<_>=names.iter().enumerate().map(|(i,name)|json!({"code":format!("E{:03}",i+1),"name":name,"department":if i==0{"Operations"}else{"Delivery"},"position":if i==0{"Dispatcher"}else{"Delivery associate"},"station":"DEMO1","active":true})).collect();
    let timecards:Vec<_>=names.iter().enumerate().flat_map(|(i,_)|dates.iter().map(move|date|json!({"employeeCode":format!("E{:03}",i+1),"date":date,"hours":if i%3==0{8.5}else{8.0},"status":"Complete","punches":[{"in":"08:00","out":"12:00","hours":4},{"in":"12:30","out":if i%3==0{"17:00"}else{"16:30"},"hours":if i%3==0{4.5}else{4.0}}]}))).collect();
    Ok(
        json!({"employees":employees,"timecards":timecards,"collectedAt":iso(),"from":dates[0],"to":today.to_string()}),
    )
}
