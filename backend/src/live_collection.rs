//! Validated, temporary driver results. Complete publications remain authoritative
//! for history; failed/cancelled/replaced attempts never overwrite them.
use super::{
    Error, Result, State,
    collectors::Provider,
    db::{self, Db, Store, s},
    ensure,
    meals::{Capture, CollectionRequest, Scope},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Semaphore, watch};

pub struct Updates {
    epoch: String,
    tenants: Mutex<HashMap<String, watch::Sender<u64>>>,
    pub slots: Arc<Semaphore>,
}
impl Updates {
    pub fn new() -> Result<Self> {
        Ok(Self {
            epoch: super::crypto::id("live")?,
            tenants: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(128)),
        })
    }
    pub fn subscribe(&self, dsp: &str) -> watch::Receiver<u64> {
        self.tenants
            .lock()
            .unwrap()
            .entry(dsp.into())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }
    pub fn notify(&self, dsp: &str) {
        if let Some(sender) = self.tenants.lock().unwrap().get(dsp) {
            sender.send_modify(|revision| *revision += 1);
        }
    }
    pub fn token(&self, receiver: &watch::Receiver<u64>) -> String {
        format!("{}:{}", self.epoch, *receiver.borrow())
    }
}

// No collection survives a restart, so neither do its live rows.
pub fn reset(db: &Db) -> Result<()> {
    db.exec("DELETE FROM collection_live_runs", [])?;
    Ok(())
}
impl Store {
    pub fn start_live(&self, job: &str, owner: &str, metadata: &Value) -> Result<()> {
        let dsp = self.guard_job(job, owner)?;
        let row = self.job(job, None)?;
        let db = self.collector(s(&dsp, "id"), Provider::from_job_kind(s(&row, "kind"))?)?;
        db.transaction(|| {
            // Each provider has one running collection per DSP. Discard any old attempt.
            db.exec("DELETE FROM collection_live_runs", [])?;
            db.exec(
                "INSERT INTO collection_live_runs VALUES (?,?,?)",
                params![job, owner, metadata.to_string()],
            )?;
            Ok(())
        })
    }
    pub fn stage_paycom(
        &self,
        job: &str,
        owner: &str,
        employee: &Value,
        records: &[Value],
    ) -> Result<()> {
        let dsp = self.guard_job(job, owner)?;
        let db = self.collector(s(&dsp, "id"), Provider::Paycom)?;
        db.transaction(|| stage_paycom_page(&db, job, owner, employee, records))
    }

    pub fn live_results(
        &self,
        dsp: &str,
        provider: Provider,
        date: &str,
    ) -> Result<Vec<(Value, Vec<Value>)>> {
        let db = self.collector(dsp, provider)?;
        let mut out = vec![];
        for job in self.jobs.all(
            "SELECT id,lease_owner FROM jobs WHERE dsp_id=? AND kind=? \
            AND status='running' AND lease_until>?",
            params![dsp, provider.job_kind(), db::now()],
        )? {
            // Includes current connection revision, actor permissions and lease ownership.
            if self
                .guard_job(s(&job, "id"), s(&job, "lease_owner"))
                .is_err()
            {
                continue;
            }
            if let Some(run) = db.one(
                "SELECT metadata FROM collection_live_runs WHERE \
                job_id=? AND owner=?",
                [s(&job, "id"), s(&job, "lease_owner")],
            )? {
                let metadata: Value = serde_json::from_str(s(&run, "metadata"))?;
                if date < s(&metadata, "from") || date > s(&metadata, "to") {
                    continue;
                }
                let items = db
                    .all(
                        "SELECT data FROM collection_live_items WHERE job_id=? \
                    AND date=? ORDER BY \
                    item_key",
                        [s(&job, "id"), date],
                    )?
                    .into_iter()
                    .map(|item| serde_json::from_str(s(&item, "data")).map_err(Into::into))
                    .collect::<Result<Vec<Value>>>()?;
                out.push((metadata, items));
            }
        }
        Ok(out)
    }
    pub fn clear_live(&self, dsp: &str, provider: Provider, job: Option<&str>) -> Result<()> {
        self.collector(dsp, provider)?.exec(
            "DELETE FROM collection_live_runs WHERE (?1 IS NULL OR job_id=?1)",
            [job],
        )?;
        Ok(())
    }
}

/// Caller has validated the whole employee page and holds its write transaction.
pub fn stage_paycom_page(
    db: &Db,
    job: &str,
    owner: &str,
    employee: &Value,
    records: &[Value],
) -> Result<()> {
    for record in records {
        let mut data = record.clone();
        for key in ["name", "department", "station"] {
            data[key] = employee[key].clone();
        }
        db.exec(
            "INSERT OR REPLACE INTO collection_live_items SELECT job_id,?1,?2,?3 FROM \
            collection_live_runs WHERE job_id=?4 AND owner=?5",
            params![
                s(employee, "code"),
                s(record, "date"),
                data.to_string(),
                job,
                owner
            ],
        )?;
    }
    Ok(())
}

pub struct Writer {
    state: Arc<State>,
    job: String,
    owner: String,
}
impl Writer {
    pub fn new(state: Arc<State>, job: &str, owner: &str) -> Self {
        Self {
            state,
            job: job.into(),
            owner: owner.into(),
        }
    }
    pub async fn start_cortex(&self, scope: &Scope, drivers: Value) -> Result<()> {
        let scope = scope.clone();
        let metadata = json!({"from":scope.date,"to":scope.date,"scope":scope,"drivers":drivers});
        let job = self.job.clone();
        let owner = self.owner.clone();
        self.state
            .run(move |db| {
                let row = db.job(&job, None)?;
                let request: CollectionRequest = serde_json::from_str(s(&row, "request"))?;
                request.validate_scope(&scope)?;
                db.start_live(&job, &owner, &metadata)
            })
            .await
    }
    pub async fn cortex_drivers(&self, drivers: Value) -> Result<()> {
        let job = self.job.clone();
        let owner = self.owner.clone();
        let dsp = self
            .state
            .run(move |db| {
                let dsp = db.guard_job(&job, &owner)?;
                db.collector(s(&dsp, "id"), Provider::Cortex)?.exec(
                    "UPDATE collection_live_runs \
                SET metadata=json_set(metadata,'$.drivers',json(?1)) WHERE job_id=?2 AND owner=?3",
                    params![drivers.to_string(), job, owner],
                )?;
                Ok(s(&dsp, "id").to_owned())
            })
            .await?;
        self.state.updates.notify(&dsp);
        Ok(())
    }
    pub async fn cortex(&self, capture: &Capture) -> Result<()> {
        // One complete itinerary, reduced to the four requested meal timestamps.
        capture.validate(&capture.scope)?;
        ensure(capture.itineraries.len() == 1, "invalid_live_capture", 502)?;
        let data = serde_json::to_string(capture)?;
        ensure(data.len() <= 64 * 1024, "invalid_live_capture", 502)?;
        let capture = capture.clone();
        let job = self.job.clone();
        let owner = self.owner.clone();
        let dsp = self
            .state
            .run(move |db| {
                let dsp = db.guard_job(&job, &owner)?;
                let row = db.job(&job, None)?;
                ensure(
                    s(&row, "kind") == Provider::Cortex.job_kind(),
                    "unsupported_collector",
                    409,
                )?;
                let storage = db.collector(s(&dsp, "id"), Provider::Cortex)?;
                let run = storage
                    .one(
                        "SELECT metadata FROM collection_live_runs WHERE job_id=? \
                AND owner=?",
                        [&job, &owner],
                    )?
                    .ok_or_else(|| Error::new("invalid_live_capture", 502))?;
                let metadata: Value = serde_json::from_str(s(&run, "metadata"))?;
                let expected: Scope = serde_json::from_value(metadata["scope"].clone())?;
                capture.validate(&expected)?;
                storage.exec(
                    "INSERT OR REPLACE INTO collection_live_items SELECT \
                job_id,?1,?2,?3 FROM collection_live_runs WHERE job_id=?4 AND \
                owner=?5",
                    params![
                        capture.itineraries[0].id,
                        capture.scope.date,
                        data,
                        job,
                        owner
                    ],
                )?;
                Ok(s(&dsp, "id").to_owned())
            })
            .await?;
        self.state.updates.notify(&dsp);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{collection_checkpoint::Checkpoint, config::Config, operations, workforce};
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn driver_results_overlay_both_views_without_publishing_and_revert_on_failure()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700))?;
        let mut config = Config::load()?;
        config.root = root.path().into();
        config.fixture = true;
        config.development = true;
        config.environment = "preview".into();
        let state = State::new(config)?;
        let (dsp, paycom_job, old) = state
            .run(|db| {
                let bootstrap = operations::bootstrap(
                    db,
                    "live@example.test",
                    "Live",
                    "Owner",
                    "live-password-test",
                )?;
                let dsp = s(&bootstrap["dsp"], "id").to_owned();
                for provider in Provider::ALL {
                    db.collector(&dsp, *provider)?
                        .exec("UPDATE connections SET enabled=1", [])?;
                }
                let old = workforce::fixture_date("UTC", Some("2026-01-19".parse().unwrap()))?;
                db.publish(&dsp, &old)?;
                let paycom = db.enqueue(&dsp, None, "live-paycom")?;
                db.claim("paycom-owner", |_, _| true)?;
                Ok((dsp, s(&paycom, "id").to_owned(), old))
            })
            .await?;
        let period = json!({"start":"2026-01-06","end":"2026-01-19"});
        let employee = old["employees"][0].clone();
        let records = (6..20)
            .map(|day| {
                json!({"employeeCode":employee["code"],"date":format!("2026-01-{day:02}"),
            "hours":9,"status":"Complete","punches":[{"in":"09:00","out":"18:00","hours":9}]})
            })
            .collect::<Vec<_>>();
        let checkpoint = Checkpoint::new(state.clone(), &paycom_job, "paycom-owner");
        let resume = checkpoint
            .prepare(&period, old["employees"].as_array().unwrap(), "UTC")
            .await?;
        let mut updates = state.updates.subscribe(&dsp);
        let other_updates = state.updates.subscribe("unrelated-dsp");
        let before = state.updates.token(&updates);
        checkpoint
            .save(&resume.token, &employee, &period, &records)
            .await?;
        updates.changed().await.unwrap();
        assert_ne!(before, state.updates.token(&updates));
        assert!(!other_updates.has_changed().unwrap());
        let tenant = dsp.clone();
        let old_snapshot = old.clone();
        state
            .run(move |db| {
                let daily = db.daily(&tenant, "2026-01-19", "name", false)?;
                assert_eq!(daily["rows"].as_array().unwrap().len(), 12);
                let row = daily["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["employeeCode"] == "E001")
                    .unwrap();
                assert_eq!(row["hours"], 9);
                assert_eq!(daily["collectedAt"], old_snapshot["collectedAt"]);
                let comparison = db.meal_comparison(&tenant, "2026-01-19", "UTC")?;
                let row = comparison["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["id"] == "paycom:E001")
                    .unwrap();
                assert_eq!(row["paycom"]["punches"][0]["in"], "09:00");
                assert!(
                    db.daily(&tenant, "2026-02-01", "name", false)?["rows"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                // A changed connection must immediately hide the old attempt.
                db.collector(&tenant, Provider::Paycom)?
                    .exec("UPDATE connections SET revision=revision+1", [])?;
                assert!(
                    db.live_results(&tenant, Provider::Paycom, "2026-01-19")?
                        .is_empty()
                );
                db.collector(&tenant, Provider::Paycom)?
                    .exec("UPDATE connections SET revision=revision-1", [])?;
                Ok(())
            })
            .await?;
        let mut empty = records.clone();
        empty.last_mut().unwrap()["punches"] = json!([]);
        checkpoint
            .save(&resume.token, &employee, &period, &empty)
            .await?;
        let tenant = dsp.clone();
        let job = paycom_job.clone();
        state
            .run(move |db| {
                let comparison = db.meal_comparison(&tenant, "2026-01-19", "UTC")?;
                assert!(
                    comparison["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|r| r["id"] != "paycom:E001")
                );
                db.finish(&job, "paycom-owner", Some("invalid_checkpoint"))?;
                let daily = db.daily(&tenant, "2026-01-19", "name", false)?;
                let row = daily["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["employeeCode"] == "E001")
                    .unwrap();
                assert_eq!(row["hours"], 8.5);
                assert!(
                    db.collector(&tenant, Provider::Paycom)?
                        .all("SELECT * FROM collection_live_items", [])?
                        .is_empty()
                );
                Ok(())
            })
            .await?;
        assert!(
            checkpoint
                .save(&resume.token, &employee, &period, &records)
                .await
                .is_err()
        );
        let scope = Scope {
            date: "2026-01-19".into(),
            station: "DEMO1".into(),
            service_area_id: "area-1".into(),
            provider: "provider-1".into(),
            timezone: "UTC".into(),
        };
        let tenant = dsp.clone();
        let requested = scope.clone();
        let flex_job = state
            .run(move |db| {
                let job = db.enqueue_meals(&tenant, None, "live-flex", &requested)?;
                db.claim("flex-owner", |_, _| true)?;
                Ok(s(&job, "id").to_owned())
            })
            .await?;
        let mut capture = crate::meals::fixture(&scope);
        capture.itineraries[0].driver = s(&employee, "name").into();
        let writer = Writer::new(state.clone(), &flex_job, "flex-owner");
        writer
            .start_cortex(
                &scope,
                json!([{"id":"fixture-driver","name":employee["name"]}]),
            )
            .await?;
        writer.cortex(&capture).await?;
        let tenant = dsp.clone();
        state
            .read(move |db| {
                let comparison = db.meal_comparison(&tenant, "2026-01-19", "UTC")?;
                let row = comparison["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["id"] == "paycom:E001")
                    .unwrap();
                assert_eq!(row["cortex"].as_array().unwrap().len(), 1);
                assert!(
                    comparison["cortexPublications"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                Ok(())
            })
            .await?;
        // Invalid data leaves the previous validated driver result intact.
        let mut invalid = capture.clone();
        invalid.scope.provider = "other-provider".into();
        assert_eq!(
            writer.cortex(&invalid).await.unwrap_err().code,
            "cortex_scope_mismatch"
        );
        invalid = capture.clone();
        invalid.itineraries[0].meals[0].end = Some(0);
        assert!(writer.cortex(&invalid).await.is_err());
        capture.itineraries[0].meals.clear();
        writer.cortex(&capture).await?;
        state
            .run(move |db| {
                let comparison = db.meal_comparison(&dsp, "2026-01-19", "UTC")?;
                assert!(
                    comparison["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|r| r["cortex"].as_array().unwrap().is_empty())
                );
                db.finish(&flex_job, "flex-owner", Some("invalid_cortex_capture"))?;
                assert!(
                    db.collector(&dsp, Provider::Cortex)?
                        .all("SELECT * FROM collection_live_items", [])?
                        .is_empty()
                );
                Ok(())
            })
            .await?;
        Ok(())
    }
}
