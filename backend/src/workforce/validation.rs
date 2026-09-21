use crate::{Error, Result, db::s, ensure, validate as v};
use serde_json::Value;
use std::collections::HashSet;
pub fn validate_workforce(value: &Value) -> Result<()> {
    v::fields(
        value,
        &[
            "employees",
            "timecards",
            "sources",
            "collectedAt",
            "from",
            "to",
        ],
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
    ensure(
        value.get("sources").is_none_or(Value::is_array),
        "invalid_workforce",
        400,
    )?;
    let mut linked = HashSet::new();
    for source in sources(value) {
        v::fields(source, &["employeeCode", "periodKey", "url"])?;
        v::text(source, "periodKey", 1, 200)?;
        v::source_url(s(source, "url"))?;
        ensure(
            codes.contains(s(source, "employeeCode")) && linked.insert(s(source, "employeeCode")),
            "timecard_source_mismatch",
            400,
        )?;
    }
    Ok(())
}
/// Collections from before links were retained, and fixtures, carry none.
pub(super) fn sources(value: &Value) -> &[Value] {
    value["sources"].as_array().map_or(&[], Vec::as_slice)
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
