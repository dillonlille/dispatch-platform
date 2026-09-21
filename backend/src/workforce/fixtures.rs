use crate::{Error, Result, db::iso};
use serde_json::{Value, json};
pub fn fixture(timezone: &str) -> Result<Value> {
    fixture_date(timezone, None)
}
pub fn fixture_date(timezone: &str, selected: Option<chrono::NaiveDate>) -> Result<Value> {
    let tz: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| Error::new("invalid_timezone", 400))?;
    let today = selected.unwrap_or_else(|| chrono::Utc::now().with_timezone(&tz).date_naive());
    // Demo periods follow the known Sep 6–19 cycle. Real collections use Paycom's bounds.
    let anchor = chrono::NaiveDate::from_ymd_opt(2026, 9, 6).unwrap();
    let start = anchor + chrono::Duration::days((today - anchor).num_days().div_euclid(14) * 14);
    let end = start + chrono::Duration::days(13);
    let dates: Vec<_> = (0..7)
        .map(|i| today - chrono::Duration::days(6 - i))
        .filter(|date| *date >= start)
        .map(|date| date.to_string())
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
    let employees: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            json!({"code":format!("E{:03}",i+1),"name":name,
        "department":if i==0{"Operations"}else{"Delivery"},
        "position":if i==0{"Dispatcher"}else{"Delivery associate"},"station":"DEMO1","active":true})
        })
        .collect();
    let timecards:Vec<_>=names.iter().enumerate().flat_map(|(i,
        _)|dates.iter().map(move|date|json!({"employeeCode":format!("E{:03}",i+1),"date":date,
        "hours":if i%3==0{8.5}else{8.0},"status":"Complete","punches":[{"in":"08:00","out":"12:00","hours":4},
        {"in":"12:30","out":if i%3==0{"17:00"}else{"16:30"},"hours":if i%3==0{4.5}else{4.0}}]}))).collect();
    Ok(
        json!({"employees":employees,"timecards":timecards,"collectedAt":iso(),"from":start.to_string(),"to":end.to_string()}),
    )
}
