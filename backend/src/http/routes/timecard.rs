//! What Paycom and Cortex collected: employees, timecards, meal breaks and the Paycom preferences.
use super::connections;
use crate::{
    Result,
    collectors::Provider,
    contracts::{EmployeeTimecardPeriod, PaycomSettings},
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
        write(
            "/api/dsp/employees/{code}/sync",
            Dsp("collections.run"),
            sync_employee,
        ),
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
    let limit = if q["limit"] == "all" {
        None
    } else {
        Some(query_number(q, "limit", 50, 1, 100)?)
    };
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
    Ok(Reply::json(serde_json::to_value(page)?))
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
    Ok(Reply::json(serde_json::to_value(db.daily(
        c.dsp_id(),
        date,
        sort,
        descending(q)?,
    )?)?))
}

fn sync_employee(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let body = &input.body;
    v::fields(body, &["requestId", "from", "to"])?;
    let period = EmployeeTimecardPeriod {
        from: v::text(body, "from", 10, 10)?.into(),
        to: v::text(body, "to", 10, 10)?.into(),
    };
    let code = input.param("code");
    let job = db.enqueue_employee_timecard(
        c.dsp_id(),
        Some(c.actor()),
        v::text(body, "requestId", 1, 128)?,
        code,
        &period,
    )?;
    c.audit(
        db,
        "collection.requested",
        &format!("{code} {}–{}", period.from, period.to),
    )?;
    Ok(Reply::status(job, 202))
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
    let mut value: PaycomSettings = serde_json::from_value(db.preferences(c.dsp_id())?)?;
    if !c.can("timecard.manage") {
        value.history.clear();
    }
    Reply::of(&value)
}

fn save_paycom_settings(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let b = &input.body;
    v::fields(b, &["revision", "values"])?;
    let revision = v::integer(b, "revision", 0, i64::MAX)?;
    let saved = db.save_preferences(c.dsp_id(), c.actor(), revision, &b["values"])?;
    Reply::of(&serde_json::from_value::<PaycomSettings>(saved)?)
}

fn meal_comparison(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.query, &["date"])?;
    let date = v::text(&input.query, "date", 10, 10)?;
    let comparison = db.meal_comparison(c.dsp_id(), date, c.dsp.timezone.as_str())?;
    Ok(Reply::json(serde_json::to_value(comparison)?))
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
