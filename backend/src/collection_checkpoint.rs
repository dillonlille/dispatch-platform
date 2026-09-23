//! Host-owned, unpublished Paycom progress. Workers never receive storage paths.
use super::{
    Result, State,
    collectors::Provider,
    crypto,
    db::{self, Store, n, s},
    ensure, workforce,
};
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

pub const TTL_MS: i64 = 15 * 60 * 1000;
impl Store {
    pub fn clear_checkpoint(&self, dsp: &str, job: Option<&str>) -> Result<()> {
        let db = self.collector(dsp, Provider::Paycom)?;
        db.exec(
            "DELETE FROM collection_checkpoints WHERE (?1 IS NULL OR job_id=?1)",
            [job],
        )?;
        Ok(())
    }
    pub fn prune_checkpoints(&self, dsp: &str) -> Result<()> {
        let db = self.collector(dsp, Provider::Paycom)?;
        db.transaction(|| {
            for row in db.all("SELECT job_id,created_at FROM collection_checkpoints", [])? {
                let live = self.job_row(s(&row, "job_id"), None).ok();
                let keep = n(&row, "created_at") <= db::now()
                    && n(&row, "created_at") >= db::now() - TTL_MS
                    && live.is_some_and(|job| {
                        job.dsp_id == dsp
                            && job.provider() == Provider::Paycom
                            && job.status.is_active()
                    });
                if !keep {
                    db.exec(
                        "DELETE FROM collection_checkpoints WHERE job_id=?",
                        [s(&row, "job_id")],
                    )?;
                }
            }
            Ok(())
        })
    }
}

#[derive(Clone)]
pub struct Checkpoint {
    state: Arc<State>,
    job: String,
    owner: String,
}
pub struct Resume {
    pub token: String,
    pub pages: BTreeMap<String, Vec<Value>>,
}
impl Checkpoint {
    pub fn new(state: Arc<State>, job: &str, owner: &str) -> Self {
        Self {
            state,
            job: job.into(),
            owner: owner.into(),
        }
    }
    pub async fn prepare(
        &self,
        period: &Value,
        employees: &[Value],
        timezone: &str,
    ) -> Result<Resume> {
        let mut roster = employees.to_vec();
        roster.sort_by(|a, b| s(a, "code").cmp(s(b, "code")));
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(
                &json!({"version":1,"timezone":timezone,"period":period,"employees":roster})
            )?)
        );
        let period = period.clone();
        let mut live_metadata = json!({"from":period["start"],"to":period["end"],"roster":roster});
        let job = self.job.clone();
        let owner = self.owner.clone();
        let (dsp, resume) = self.state.run(move |db| {
            let dsp=db.guard_job(&job,&owner)?;
            let row=db.job(&job,None)?;
            ensure(s(&row,"kind")==Provider::Paycom.job_kind(),"unsupported_collector",409)?;
            let tenant=s(&dsp,"id");
            db.prune_checkpoints(tenant)?;
            let storage=db.collector(tenant,Provider::Paycom)?;
            let resume = storage.transaction(|| {
                let existing=storage.one("SELECT * FROM collection_checkpoints WHERE job_id=?",[&job])?;
                if let Some(existing)=existing.filter(|r| s(r,
                    "fingerprint")==fingerprint && r["connection_revision"]==row["connection_revision"]) {
                    let mut pages=BTreeMap::new();
                    let mut valid=true;
                    for page in storage.all("SELECT employee_code,data FROM collection_checkpoint_pages WHERE job_id=?",[&job])? {
                        let code=s(&page,"employee_code");
                        let parsed=serde_json::from_str::<Vec<Value>>(s(&page,"data"));
                        match (roster.iter().find(|e|s(e,"code")==code),parsed) {
                            (Some(employee),Ok(records)) if validate_page(employee,&period,
                                &records).is_ok()=>{pages.insert(code.into(),records);},
                            _=>{valid=false;break;}
                        }
                    }
                    if valid { return Ok(Resume { token:s(&existing,"token").into(),pages }); }
                }
                storage.exec("DELETE FROM collection_checkpoints WHERE job_id=?",[&job])?;
                let token=crypto::id("checkpoint")?;
                storage.exec("INSERT INTO \
                    collection_checkpoints(job_id,connection_revision,fingerprint,created_at,token) VALUES (?,?,?,?,?)",
                params![job,n(&row,"connection_revision"),fingerprint,db::now(),
                token])?;
                Ok(Resume { token,pages:BTreeMap::new() })
            })?;
            live_metadata["checkpointToken"]=json!(resume.token);
            drop(storage);
            db.start_live(&job,&owner,&live_metadata)?;
            for employee in &roster {
                if let Some(records)=resume.pages.get(s(employee,"code")) {
                    db.stage_paycom(&job,&owner,employee,records)?;
                }
            }
            Ok((tenant.to_owned(), resume))
        }).await?;
        self.state
            .updates
            .changed(&dsp, crate::contracts::CollectionChange::provider("paycom"));
        Ok(resume)
    }
    pub async fn save(
        &self,
        token: &str,
        employee: &Value,
        period: &Value,
        records: &[Value],
    ) -> Result<()> {
        validate_page(employee, period, records)?;
        let change = crate::contracts::CollectionChange {
            provider: "paycom".into(),
            dates: records.iter().map(|r| s(r, "date").to_owned()).collect(),
            employee_code: Some(s(employee, "code").to_owned()),
            roster: false,
        };
        let token = token.to_owned();
        let code = s(employee, "code").to_owned();
        let data = serde_json::to_string(records)?;
        ensure(data.len() <= 256 * 1024, "checkpoint_too_large", 502)?;
        let employee = employee.clone();
        let records = records.to_vec();
        let job = self.job.clone();
        let owner = self.owner.clone();
        let dsp = self
            .state
            .run(move |db| {
                let dsp = db.guard_job(&job, &owner)?;
                let row = db.job(&job, None)?;
                let storage = db.collector(s(&dsp, "id"), Provider::Paycom)?;
                // Save resume data and visible results with one transaction per driver.
                storage.transaction(|| {
                    // An expired checkpoint simply stops accepting new progress. The
                    // current in-memory collection may still finish and publish normally.
                    storage.exec(
                        "INSERT OR REPLACE INTO \
                collection_checkpoint_pages(job_id,employee_code,data) SELECT job_id,?1,?2 \
                FROM collection_checkpoints WHERE job_id=?3 AND token=?4 AND \
                connection_revision=?5 AND created_at>=?6 AND \
                created_at<=?7",
                        params![
                            code,
                            data,
                            job,
                            token,
                            n(&row, "connection_revision"),
                            db::now() - TTL_MS,
                            db::now()
                        ],
                    )?;
                    // Expiry limits resume reuse, not validated live visibility. An old
                    // checkpoint token must never write into a replacement run.
                    if storage
                        .one(
                            "SELECT 1 FROM collection_live_runs WHERE job_id=? AND \
                json_extract(metadata,'$.checkpointToken')=?",
                            [&job, &token],
                        )?
                        .is_some()
                    {
                        super::live_collection::stage_paycom_page(
                            &storage, &job, &owner, &employee, &records,
                        )?;
                    }
                    Ok(())
                })?;
                Ok(s(&dsp, "id").to_owned())
            })
            .await?;
        self.state.updates.changed(&dsp, change);
        Ok(())
    }
}
fn validate_page(employee: &Value, period: &Value, records: &[Value]) -> Result<()> {
    ensure(records.len() == 14, "invalid_checkpoint", 502)?;
    let start = chrono::NaiveDate::parse_from_str(s(period, "start"), "%Y-%m-%d")
        .map_err(|_| super::Error::new("invalid_checkpoint", 502))?;
    for (index, record) in records.iter().enumerate() {
        ensure(
            record["employeeCode"] == employee["code"]
                && s(record, "date")
                    == start
                        .checked_add_signed(chrono::Duration::days(index as i64))
                        .ok_or_else(|| super::Error::new("invalid_checkpoint", 502))?
                        .format("%Y-%m-%d")
                        .to_string(),
            "invalid_checkpoint",
            502,
        )?;
    }
    workforce::validate_workforce(
        &json!({"employees":[employee],"timecards":records,"from":period["start"],"to":period["end"],"collectedAt":db::iso()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, operations};
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn resume_is_bound_to_job_roster_period_revision_and_fixed_expiry() -> Result<()> {
        let root = tempfile::tempdir()?;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700))?;
        let mut config = Config::load()?;
        config.root = root.path().into();
        config.fixture = true;
        config.development = true;
        config.environment = "preview".into();
        let state = State::new(config)?;
        let (dsp, job) = state
            .run(|db| {
                let bootstrap = operations::bootstrap(
                    db,
                    "checkpoint@example.test",
                    "Test",
                    "Owner",
                    "checkpoint-password",
                )?;
                let dsp = s(&bootstrap["dsp"], "id").to_owned();
                db.collector(&dsp, Provider::Paycom)?
                    .exec("UPDATE connections SET enabled=1,revision=1", [])?;
                let job = db.enqueue(&dsp, None, "checkpoint-test")?;
                db.claim("owner", |_, _| true)?;
                Ok((dsp, s(&job, "id").to_owned()))
            })
            .await?;
        let checkpoint = Checkpoint::new(state.clone(), &job, "owner");
        let employee = json!({"code":"AA01","name":"Fixture","department":"Driver","position":"Driver","station":"S","active":true});
        let period = json!({"start":"2026-09-06","end":"2026-09-19"});
        let records = (6..20)
            .map(|day| {
                json!({"employeeCode":"AA01","date":format!("2026-09-{day:02}"),"hours":0,
            "status":"Complete","punches":[]})
            })
            .collect::<Vec<_>>();
        let prepare = || checkpoint.prepare(&period, std::slice::from_ref(&employee), "UTC");
        let initial = prepare().await?;
        checkpoint
            .save(&initial.token, &employee, &period, &records)
            .await?;
        let resumed = prepare().await?;
        assert_eq!(resumed.token, initial.token);
        assert_eq!(resumed.pages["AA01"], records);
        assert!(
            checkpoint
                .save(&initial.token, &employee, &period, &records[..13])
                .await
                .is_err()
        );
        let mut wrong = records.clone();
        wrong[0]["employeeCode"] = json!("BB02");
        assert!(
            checkpoint
                .save(&initial.token, &employee, &period, &wrong)
                .await
                .is_err()
        );

        let mut changed_employee = employee.clone();
        changed_employee["name"] = json!("Changed");
        let changed = checkpoint
            .prepare(&period, &[changed_employee], "UTC")
            .await?;
        assert!(changed.pages.is_empty());
        assert_ne!(changed.token, initial.token);
        checkpoint
            .save(&initial.token, &employee, &period, &records)
            .await?;
        assert!(
            prepare().await?.pages.is_empty(),
            "old token cannot repopulate a replaced checkpoint"
        );
        let current = prepare().await?;
        checkpoint
            .save(&current.token, &employee, &period, &records)
            .await?;
        assert!(
            checkpoint
                .prepare(&period, std::slice::from_ref(&employee), "America/New_York")
                .await?
                .pages
                .is_empty()
        );
        assert!(
            checkpoint
                .prepare(
                    &json!({"start":"2026-09-20","end":"2026-10-03"}),
                    std::slice::from_ref(&employee),
                    "UTC"
                )
                .await?
                .pages
                .is_empty()
        );
        let current = prepare().await?;
        checkpoint
            .save(&current.token, &employee, &period, &records)
            .await?;
        let tenant = dsp.clone();
        let id = job.clone();
        state
            .run(move |db| {
                let storage = db.collector(&tenant, Provider::Paycom)?;
                storage.exec(
                    "UPDATE collection_checkpoints SET created_at=? WHERE job_id=?",
                    params![db::now() - TTL_MS - 1, id],
                )?;
                Ok(())
            })
            .await?;
        let fresh = prepare().await?;
        assert!(fresh.pages.is_empty());
        assert_ne!(fresh.token, current.token);
        checkpoint
            .save(&fresh.token, &employee, &period, &records)
            .await?;
        let tenant = dsp.clone();
        let id = job.clone();
        state
            .run(move |db| {
                let storage = db.collector(&tenant, Provider::Paycom)?;
                storage.exec("UPDATE connections SET revision=2", [])?;
                db.jobs
                    .exec("UPDATE jobs SET connection_revision=2 WHERE id=?", [id])?;
                Ok(())
            })
            .await?;
        let revised = prepare().await?;
        assert!(revised.pages.is_empty());
        assert_ne!(fresh.token, revised.token);
        checkpoint
            .save(&revised.token, &employee, &period, &records)
            .await?;
        let tenant = dsp.clone();
        let id = job.clone();
        let other = state
            .run(move |db| {
                db.finish(&id, "owner", Some("provider_unavailable"))?;
                let other = db.enqueue(&tenant, None, "separate-job")?;
                db.claim("new-owner", |_, _| true)?;
                Ok(s(&other, "id").to_owned())
            })
            .await?;
        let separate = Checkpoint::new(state.clone(), &other, "new-owner");
        assert!(
            separate
                .prepare(&period, std::slice::from_ref(&employee), "UTC")
                .await?
                .pages
                .is_empty()
        );
        let tenant = dsp.clone();
        state
            .run(move |db| {
                db.finish(&other, "new-owner", None)?;
                assert_eq!(
                    db.collector(&tenant, Provider::Paycom)?
                        .all("SELECT * FROM collection_checkpoint_pages", [])?
                        .len(),
                    1,
                    "a separate job cannot consume or clear another job's pages"
                );
                Ok(())
            })
            .await?;
        let tenant = dsp.clone();
        let id = job.clone();
        state
            .run(move |db| {
                db.cancel_job(&id, &tenant)?;
                Ok(())
            })
            .await?;
        assert!(
            checkpoint
                .save(&revised.token, &employee, &period, &records)
                .await
                .is_err()
        );
        state
            .run(move |db| {
                assert!(
                    db.collector(&dsp, Provider::Paycom)?
                        .all("SELECT * FROM collection_checkpoint_pages", [])?
                        .is_empty()
                );
                Ok(())
            })
            .await?;
        Ok(())
    }
}
