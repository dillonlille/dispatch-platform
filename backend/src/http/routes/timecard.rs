//! What Paycom and Cortex collected: employees, timecards, meal breaks and the Paycom preferences.
use super::connections;
use crate::{
    Result,
    collectors::Provider,
    contracts::EmployeeTimecardPeriod,
    db::Store,
    http::{
        input::{Input, Reply, descending, optional, optional_text, query_number},
        route::{Dsp, Member, Route, read, write},
    },
    validate as v,
};
use serde_json::json;

const VIEW: Dsp = Dsp("timecard.view");
const MANAGE: Dsp = Dsp("timecard.manage");
const SORTS: &[&str] = &[
    "name",
    "hours",
    "inDay",
    "outLunch",
    "inLunch",
    "outDay",
    "totalHours",
    "condition",
];

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/employees", VIEW, employees),
        read("/api/dsp/employees/{code}", VIEW, employee),
        read("/api/dsp/timecards", VIEW, timecards),
        read("/api/dsp/paycom/status", VIEW, paycom_status),
        read("/api/dsp/paycom/settings", VIEW, paycom_settings),
        write("/api/dsp/paycom/settings", MANAGE, save_paycom_settings),
        read("/api/dsp/paycom/meal-breaks", VIEW, meal_comparison),
        write(
            "/api/dsp/paycom/employee-links",
            MANAGE,
            save_employee_links,
        ),
        read("/api/dsp/cortex/meal-breaks", VIEW, cortex_meal_breaks),
    ]
}

fn employees(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let q = &input.query;
    v::fields(q, &["q", "direction", "offset", "limit", "status"])?;
    let query = optional_text(q, "q", 100)?;
    let desc = descending(q)?;
    let offset = query_number(q, "offset", 0, 0, 100000)?;
    let limit = query_number(q, "limit", 50, 1, 100)?;
    let status = optional(q, "status", |q, key| {
        v::choice(q, key, &["all", "active", "inactive"])
    })?
    .unwrap_or("all");
    let active = match status {
        "active" => Some(true),
        "inactive" => Some(false),
        _ => None,
    };
    let page = db.employees(c.dsp_id(), query, offset, limit, desc, active)?;
    Ok(Reply::json(page))
}

fn employee(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let q = &input.query;
    v::fields(q, &["from", "to"])?;
    let period = if q.get("from").is_some() || q.get("to").is_some() {
        let from = v::text(q, "from", 10, 10)?;
        let to = v::text(q, "to", 10, 10)?;
        v::date(from)?;
        v::date(to)?;
        crate::ensure(from <= to, "invalid_period", 400)?;
        Some(EmployeeTimecardPeriod {
            from: from.into(),
            to: to.into(),
        })
    } else {
        None
    };
    Ok(Reply::json(serde_json::to_value(db.employee_timecard(
        c.dsp_id(),
        input.param("code"),
        period.as_ref(),
    )?)?))
}

fn timecards(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let q = &input.query;
    v::fields(q, &["date", "sort", "direction"])?;
    let sort = optional(q, "sort", |q, key| v::choice(q, key, SORTS))?.unwrap_or("name");
    let date = v::text(q, "date", 10, 10)?;
    Ok(Reply::json(db.daily(
        c.dsp_id(),
        date,
        sort,
        descending(q)?,
    )?))
}

fn paycom_status(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    let publication = db
        .collector(c.dsp_id(), Provider::Paycom)?
        .one("SELECT collected_at FROM publications WHERE active=1", [])?;
    Ok(Reply::json(json!({
        "connection":connections::summary(db, c)?,
        "workforce":{"collectedAt":publication.map(|p| p["collected_at"].clone())}
    })))
}

// The change history names people, so only those who manage timecards see it.
fn paycom_settings(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    let mut value = db.preferences(c.dsp_id())?;
    if !c.can("timecard.manage") {
        value["history"] = json!([]);
    }
    Ok(Reply::json(value))
}

fn save_paycom_settings(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let b = &input.body;
    v::fields(b, &["revision", "values"])?;
    let revision = v::integer(b, "revision", 0, i64::MAX)?;
    let saved = db.save_preferences(c.dsp_id(), c.actor(), revision, &b["values"])?;
    Ok(Reply::json(saved))
}

fn meal_comparison(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.query, &["date"])?;
    let date = v::text(&input.query, "date", 10, 10)?;
    let comparison = db.meal_comparison(c.dsp_id(), date, c.dsp.timezone.as_str())?;
    Ok(Reply::json(comparison))
}

fn save_employee_links(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let links = db.save_employee_links(c.dsp_id(), c.actor(), &input.body)?;
    Ok(Reply::json(links))
}

fn cortex_meal_breaks(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.query, &["date"])?;
    let date = v::text(&input.query, "date", 10, 10)?;
    Ok(Reply::json(db.meal_publications(c.dsp_id(), date)?))
}
