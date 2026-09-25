//! Cortex: meal evidence from Amazon Logistics. Its storage was added to DSPs that
//! already existed, which is the path every later provider takes.
use super::AddedStorage;
use super::Collector;
use crate::{
    Error, Result,
    browsers::{
        Collected, Driver, Pending,
        browseros::{self, NetworkPolicy},
        cortex,
    },
    db::{self, Db, Kind, Store},
    ensure,
    meals::{self, CollectionRequest},
    scorecard, validate as v,
};
use serde_json::{Value, json};
use std::path::Path;

pub(super) struct Cortex;
impl Collector for Cortex {
    fn id(&self) -> &'static str {
        "cortex"
    }
    fn label(&self) -> &'static str {
        "Cortex"
    }
    fn capability(&self) -> &'static str {
        "meal_breaks"
    }
    fn job_kind(&self) -> &'static str {
        "cortex.meal_breaks.collect"
    }
    fn other_job_kinds(&self) -> &'static [&'static str] {
        &[scorecard::JOB_KIND]
    }
    fn job_kind_for(&self, request: &Value) -> &'static str {
        if scorecard::Request::is(request) {
            scorecard::JOB_KIND
        } else {
            self.job_kind()
        }
    }
    fn added_storages(&self) -> &'static [AddedStorage] {
        std::slice::from_ref(&scorecard::STORAGE)
    }
    fn database(&self) -> Kind {
        Kind::Cortex
    }
    fn seed(&self, dsp: &str) -> String {
        format!(
            "INSERT INTO storage_identity VALUES ('{dsp}','cortex','cortex-v1');\nINSERT \
                INTO connections(provider,updated_at) VALUES ('cortex','{}');",
            db::iso()
        )
    }
    fn marker(&self) -> Option<&'static str> {
        Some("storage.cortex")
    }
    fn verify(&self, db: &Db) -> Result<()> {
        ensure(
            db.all("SELECT version FROM meal_schema", [])? == vec![json!({"version":1})],
            "unsupported_cortex_schema",
            503,
        )?;
        // Missing initialized feature tables fail closed, rather than recreating lost data.
        // meal_delivery_events, meal_breaks and their trigger hold nothing and are not
        // required here. The baseline still creates them because v0.0.9 refuses to start
        // without them.
        for table in ["meal_publications", "meal_itineraries"] {
            db.one(&format!("SELECT count(*) FROM {table} WHERE 0"), [])?;
        }
        ensure(
            db.all("SELECT version FROM meal_record_schema", [])? == vec![json!({"version":1})],
            "unsupported_cortex_schema",
            503,
        )?;
        db.one("SELECT count(*) FROM meal_records WHERE 0", [])?;
        Ok(())
    }
    fn browser_entries(&self) -> &'static [&'static str] {
        &[
            "cortex-browseros",
            "cortex-attempt.json",
            ".cortex-browseros.browseros.lock",
        ]
    }
    fn network(&self) -> NetworkPolicy {
        NetworkPolicy::Cortex
    }
    fn validate_credentials(&self, value: &Value) -> Result<()> {
        v::fields(value, &["username", "password"])?;
        v::name(value, "username", 200)?;
        v::text(value, "password", 1, 256)?;
        Ok(())
    }
    fn driver<'a>(
        &self,
        browser: browseros::Session,
        profile: &'a Path,
        fixture: Option<&'a str>,
    ) -> Pending<'a, Box<dyn Driver>> {
        Box::pin(async move {
            Ok(Box::new(cortex::Driver::new(browser, profile, fixture).await?) as Box<dyn Driver>)
        })
    }
    fn fixture(&self, _: &str, request: &Value) -> Result<Collected> {
        if let Some(request) = scorecard::Request::parse(request)? {
            return Ok(Collected {
                data: serde_json::to_value(scorecard::fixture(&request)?)?,
                scope: None,
            });
        }
        let scope = match serde_json::from_value(request.clone())? {
            CollectionRequest::Scoped(scope) => scope,
            CollectionRequest::Discover(discovery) => {
                discovery.scope("area-demo", "provider-demo")?
            }
        };
        Ok(Collected {
            data: serde_json::to_value(meals::fixture(&scope))?,
            scope: Some(scope),
        })
    }
    fn progress(&self, request: &Value) -> &'static str {
        if scorecard::Request::is(request) {
            "Collecting scorecard"
        } else {
            "Collecting meal breaks"
        }
    }
    fn publish(&self, store: &Store, dsp: &str, job: &str, collected: Collected) -> Result<()> {
        if scorecard::Request::is(&collected.data) {
            return store.publish_scorecard(dsp, job, &serde_json::from_value(collected.data)?);
        }
        store.publish_meals(
            dsp,
            job,
            &serde_json::from_value(collected.data)?,
            &collected
                .scope
                .ok_or_else(|| Error::new("invalid_cortex_scope", 502))?,
        )?;
        Ok(())
    }
    fn collected_at(&self, db: &Db, date: &str) -> Result<Option<Value>> {
        db.one("SELECT MAX(collected_at) collected_at FROM meal_publications WHERE report_date=? AND active=1",[date])
    }
    fn schedules(&self) -> &'static [(&'static str, &'static str)] {
        &[
            ("meal_break", "schedule_meals_required"),
            ("scorecard", "schedule_scorecard_required"),
        ]
    }
    fn schedule_ready(&self, store: &Store, dsp: &str, collection: &str) -> Result<()> {
        if collection == "scorecard" {
            return store.scorecard_schedule_ready(dsp);
        }
        ensure(
            !store
                .meal_sync_scopes(dsp, &store.local_date(dsp)?)?
                .is_empty(),
            "schedule_scope_required",
            409,
        )
    }
    fn scheduled(
        &self,
        store: &Store,
        dsp: &str,
        collection: &str,
    ) -> Result<Vec<(String, Value)>> {
        if collection == "scorecard" {
            return store.scorecard_jobs(dsp);
        }
        store
            .meal_sync_scopes(dsp, &store.local_date(dsp)?)?
            .iter()
            .enumerate()
            .map(|(index, scope)| {
                scope.validate()?;
                Ok((format!("flex:{index}"), serde_json::to_value(scope)?))
            })
            .collect()
    }
}
