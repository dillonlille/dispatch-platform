//! Employee timecards: calendar navigation and explicitly scoped collections.
use crate::{
    Error, Result,
    collectors::Provider,
    contracts::{EmployeeTimecardPeriod, EmployeeTimecardResponse, JobRow},
    db::{Store, boolean, s},
    employee_sync::synced_cards,
    ensure, validate as v,
    workforce::{cards, display_name},
};
use chrono::{Duration, NaiveDate};
use rusqlite::params;
use serde_json::{Value, json};

pub(crate) const PERIOD_DAYS: i64 = 14;
const EARLIEST_DATE: &str = "2000-01-01";

impl EmployeeTimecardPeriod {
    pub(crate) fn start(&self) -> Result<NaiveDate> {
        v::date(&self.from)?;
        v::date(&self.to)?;
        let start: NaiveDate = self
            .from
            .parse()
            .map_err(|_| Error::new("invalid_period", 400))?;
        ensure(
            (start + Duration::days(PERIOD_DAYS - 1)).to_string() == self.to,
            "invalid_period",
            400,
        )?;
        Ok(start)
    }
    fn shift(&self, periods: i64) -> Result<Self> {
        let start = self.start()? + Duration::days(periods * PERIOD_DAYS);
        Ok(Self {
            from: start.to_string(),
            to: (start + Duration::days(PERIOD_DAYS - 1)).to_string(),
        })
    }
    pub(crate) fn provider_period(&self) -> Result<Value> {
        let start = self.start()?;
        Ok(
            json!({"start":self.from,"end":self.to,"key":format!("{}_{}",self.from,self.to),
            "dates":(0..PERIOD_DAYS).map(|i|(start+Duration::days(i)).to_string()).collect::<Vec<_>>()}),
        )
    }
}

impl Store {
    pub(crate) fn paycom_employee(&self, id: &str, code: &str) -> Result<Value> {
        v::code(code)?;
        let mut employee = self
            .collector(id, Provider::Paycom)?
            .one(
                "SELECT e.code,e.name,e.department,e.position,e.station,e.active \
             FROM employees e JOIN publications p ON p.id=e.publication_id \
             WHERE e.code=? ORDER BY p.period_to DESC,p.period_from DESC,\
             p.collected_at DESC,p.rowid DESC LIMIT 1",
                [code],
            )?
            .ok_or_else(|| Error::new("employee_not_found", 404))?;
        boolean(&mut employee, &["active"]);
        Ok(employee)
    }
    pub fn employee_timecard(
        &self,
        id: &str,
        code: &str,
        requested: Option<&EmployeeTimecardPeriod>,
    ) -> Result<EmployeeTimecardResponse> {
        let mut employee = self.paycom_employee(id, code)?;
        let db = self.collector(id, Provider::Paycom)?;
        let latest = db
            .one_as::<EmployeeTimecardPeriod>(
                "SELECT p.period_from,p.period_to FROM publications p \
             JOIN employees e ON e.publication_id=p.id WHERE e.code=? \
             ORDER BY p.period_to DESC,p.period_from DESC LIMIT 1",
                [code],
            )?
            .ok_or_else(|| Error::new("employee_not_found", 404))?;
        let period = requested.unwrap_or(&latest);
        let offset = (latest.start()? - period.start()?).num_days();
        ensure(
            period.from.as_str() >= EARLIEST_DATE && offset >= 0 && offset % PERIOD_DAYS == 0,
            "invalid_period",
            400,
        )?;
        let publication = db.one(
            "SELECT p.id,p.collected_at FROM publications p JOIN employees e ON e.publication_id=p.id \
             WHERE e.code=? AND p.period_from=? AND p.period_to=? \
             ORDER BY p.collected_at DESC,p.rowid DESC LIMIT 1",
            params![code, period.from, period.to],
        )?;
        let mut collected_at = publication
            .as_ref()
            .map(|p| s(p, "collected_at").to_owned());
        let mut timecards = if let Some(p) = &publication {
            cards(
                &db,
                "SELECT t.employee_code employeeCode,t.date,t.hours,t.status,t.punches,u.url \
                 sourceUrl FROM timecards t LEFT JOIN timecard_sources u ON \
                 u.publication_id=t.publication_id AND u.employee_code=t.employee_code \
                 WHERE t.publication_id=? AND t.employee_code=? ORDER BY t.date DESC",
                [s(p, "id"), code],
            )?
        } else {
            vec![]
        };
        if let Some(sync) = db.one(
            "SELECT data,collected_at FROM employee_timecard_syncs WHERE employee_code=? \
             AND period_from=? AND period_to=? AND collected_at>=?",
            params![
                code,
                period.from,
                period.to,
                collected_at.as_deref().unwrap_or("")
            ],
        )? {
            timecards = synced_cards(&serde_json::from_str::<Value>(s(&sync, "data"))?);
            timecards.sort_by(|a, b| s(b, "date").cmp(s(a, "date")));
            collected_at = Some(s(&sync, "collected_at").to_owned());
        }
        let settings = self.preferences(id)?;
        employee["name"] = json!(display_name(
            s(&employee, "name"),
            s(&settings["values"], "name_order")
        ));
        let previous = period.shift(-1)?;
        let job = self.jobs.one_as::<JobRow>(
            "SELECT * FROM jobs WHERE dsp_id=? AND kind='paycom.collect' \
             AND json_extract(request,'$.employeeCode')=? AND json_extract(request,'$.from')=? \
             AND json_extract(request,'$.to')=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            params![id, code, period.from, period.to],
        )?;
        Ok(EmployeeTimecardResponse {
            employee,
            timecards,
            period: period.clone(),
            collected_at,
            previous_period: (previous.from.as_str() >= EARLIEST_DATE).then_some(previous),
            next_period: (period != &latest).then(|| period.shift(1)).transpose()?,
            sync_status: job.map(|job| job.status),
        })
    }
}
