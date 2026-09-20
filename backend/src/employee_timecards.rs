//! One employee's collected pay periods, with the latest revision of each period.
use crate::{
    Error, Result,
    collectors::Provider,
    contracts::{EmployeeTimecardPeriod, EmployeeTimecardResponse},
    db::{Store, boolean, s},
    validate as v,
    workforce::{cards, display_name},
};
use rusqlite::params;
use serde_json::json;

impl Store {
    pub fn employee_timecard(
        &self,
        id: &str,
        code: &str,
        requested: Option<&EmployeeTimecardPeriod>,
    ) -> Result<EmployeeTimecardResponse> {
        v::code(code)?;
        let db = self.collector(id, Provider::Paycom)?;
        // Sort by period, not collection time: re-syncing an old period must not
        // make it the latest timecard. Repeated collections occupy one stop.
        let periods = db.query_as::<EmployeeTimecardPeriod>(
            "SELECT DISTINCT p.period_from,p.period_to FROM publications p \
             JOIN employees e ON e.publication_id=p.id WHERE e.code=? \
             ORDER BY p.period_to DESC,p.period_from DESC",
            [code],
        )?;
        if periods.is_empty() {
            return Err(Error::new("employee_not_found", 404));
        }
        let index = match requested {
            Some(period) => periods
                .iter()
                .position(|p| p == period)
                .ok_or_else(|| Error::new("employee_timecard_not_found", 404))?,
            None => 0,
        };
        let period = &periods[index];
        let (publication,) = db
            .one_as::<(String,)>(
                "SELECT p.id FROM publications p JOIN employees e ON e.publication_id=p.id \
                 WHERE e.code=? AND p.period_from=? AND p.period_to=? \
                 ORDER BY p.collected_at DESC,p.rowid DESC LIMIT 1",
                params![code, period.from, period.to],
            )?
            .ok_or_else(|| Error::new("employee_timecard_not_found", 404))?;
        // Employee identity stays current while their historical hours change.
        let mut employee = db
            .one(
                "SELECT e.code,e.name,e.department,e.position,e.station,e.active \
                 FROM employees e JOIN publications p ON p.id=e.publication_id \
                 WHERE e.code=? ORDER BY p.period_to DESC,p.period_from DESC,\
                 p.collected_at DESC,p.rowid DESC LIMIT 1",
                [code],
            )?
            .ok_or_else(|| Error::new("employee_not_found", 404))?;
        let settings = self.preferences(id)?;
        boolean(&mut employee, &["active"]);
        employee["name"] = json!(display_name(
            s(&employee, "name"),
            s(&settings["values"], "name_order")
        ));
        let timecards = cards(
            &db,
            "SELECT t.employee_code employeeCode,t.date,t.hours,t.status,t.punches,u.url \
             sourceUrl FROM timecards t LEFT JOIN timecard_sources u ON \
             u.publication_id=t.publication_id AND u.employee_code=t.employee_code \
             WHERE t.publication_id=? AND t.employee_code=? ORDER BY t.date DESC",
            [publication.as_str(), code],
        )?;
        Ok(EmployeeTimecardResponse {
            employee,
            timecards,
            period: period.clone(),
            previous_period: periods.get(index + 1).cloned(),
            next_period: index.checked_sub(1).and_then(|i| periods.get(i)).cloned(),
        })
    }
}
