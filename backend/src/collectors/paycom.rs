//! Paycom: employees and timecards. Every DSP was created with this storage.
use super::Collector;
use crate::{
    Error, Result,
    browsers::{
        Collected, Driver, Pending,
        browseros::{self, NetworkPolicy},
        paycom,
    },
    db::{Db, Kind, Store, s},
    ensure, validate as v, workforce,
    workforce::sync::EmployeeSync,
};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

pub(super) struct Paycom;
impl Collector for Paycom {
    fn id(&self) -> &'static str {
        "paycom"
    }
    fn job_kind(&self) -> &'static str {
        "paycom.collect"
    }
    fn database(&self) -> Kind {
        Kind::Paycom
    }
    fn seed(&self, dsp: &str) -> String {
        format!("INSERT INTO storage_identity VALUES ('{dsp}','paycom','paycom-v1');")
    }
    fn marker(&self) -> Option<&'static str> {
        None
    }
    fn opened(&self, store: &Store, dsp: &str) -> Result<()> {
        store.prune_checkpoints(dsp)
    }
    fn browser_entries(&self) -> &'static [&'static str] {
        &[
            "paycom", // Retired profile retained on existing hosts.
            "paycom-browseros",
            "paycom-attempt.json",
            "paycom-diagnostics.json",
            ".paycom-browseros.browseros.lock",
        ]
    }
    fn network(&self) -> NetworkPolicy {
        NetworkPolicy::Paycom
    }
    fn validate_credentials(&self, value: &Value) -> Result<()> {
        v::fields(
            value,
            &["clientCode", "username", "password", "securityAnswers"],
        )?;
        v::name(value, "clientCode", 80)?;
        v::name(value, "username", 200)?;
        v::text(value, "password", 1, 256)?;
        let answers = value["securityAnswers"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", 400))?;
        ensure(
            answers.len() == 5
                && answers.iter().all(|a| {
                    a.as_str().is_some_and(|s| {
                        !s.is_empty() && s.chars().count() <= 64 && !s.contains(['\r', '\n', '\0'])
                    })
                })
                && answers
                    .iter()
                    .map(Value::to_string)
                    .collect::<HashSet<_>>()
                    .len()
                    == 5,
            "invalid_input",
            400,
        )
    }
    fn account_label<'a>(&self, credentials: &'a Value) -> &'a str {
        s(credentials, "clientCode")
    }
    fn driver<'a>(
        &self,
        browser: browseros::Session,
        profile: &'a Path,
        fixture: Option<&'a str>,
    ) -> Pending<'a, Box<dyn Driver>> {
        Box::pin(async move {
            Ok(Box::new(paycom::Driver::new(browser, profile, fixture).await?) as Box<dyn Driver>)
        })
    }
    fn fixture(&self, timezone: &str, request: &Value) -> Result<Collected> {
        let data = if let Some(scope) = EmployeeSync::parse(request)? {
            scope.fixture(timezone)?
        } else {
            workforce::fixture_date(timezone, workforce::collection_date(request, timezone)?)?
        };
        Ok(Collected { data, scope: None })
    }
    fn progress(&self) -> &'static str {
        "Collecting workforce"
    }
    fn publish(&self, store: &Store, dsp: &str, job: &str, collected: Collected) -> Result<()> {
        let request: Value = serde_json::from_str(&store.job_row(job, Some(dsp))?.request)?;
        if let Some(scope) = EmployeeSync::parse(&request)? {
            store.publish_employee_timecard(dsp, &scope, &collected.data)?;
        } else {
            store.publish(dsp, &collected.data)?;
        }
        Ok(())
    }
    fn discard(&self, store: &Store, dsp: &str, job: Option<&str>) -> Result<()> {
        store.clear_checkpoint(dsp, job)
    }
    fn collected_at(&self, db: &Db, date: &str) -> Result<Option<Value>> {
        db.one(
            "SELECT collected_at FROM publications WHERE period_from<=? AND period_to>=? \
            ORDER BY collected_at DESC,id DESC LIMIT 1",
            [date, date],
        )
    }
    fn schedule(&self) -> Option<(&'static str, &'static str)> {
        Some(("paycom", "schedule_paycom_required"))
    }
    fn scheduled(&self, _: &Store, _: &str) -> Result<Vec<(String, Value)>> {
        Ok(vec![("paycom".into(), json!({}))])
    }
    // v0.0.9 refuses Paycom settings saves while its old schedule row is on
    // and Paycom is disconnected. Drop this with the table.
    fn disabled(&self, db: &Db) -> Result<()> {
        db.exec(
            "UPDATE schedules SET enabled=0,next_run=NULL WHERE provider=?",
            [self.id()],
        )?;
        Ok(())
    }
}
