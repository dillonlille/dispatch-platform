//! Queue both sources together; a missing connection/scope cannot start half a sync.
use super::{
    Result,
    collectors::Provider,
    db::{Store, flag, s},
    ensure,
    meals::{Discovery, Scope},
    workforce,
};
use rusqlite::params;
use serde_json::{Value, json};

impl Store {
    fn meal_sync_discovery(&self, id: &str, date: &str) -> Result<Discovery> {
        let profile = self.profile(id)?;
        let dsp = self.get_dsp(id)?;
        Ok(Discovery {
            date: date.into(),
            station: s(&profile, "stationCode").into(),
            timezone: s(&dsp, "timezone").into(),
            dsp_name: s(&dsp, "name").into(),
            dsp_abbreviation: s(&profile, "abbreviation").into(),
        })
    }
    pub(crate) fn meal_sync_scopes(&self, id: &str, date: &str) -> Result<Vec<Scope>> {
        let db = self.collector(id, Provider::Cortex)?;
        // Reuse the selected day's proven scopes. For an uncollected day, use the
        // most recently collected day's scopes, never another DSP or ALL_DSPS.
        let rows = db.all("SELECT station,service_area_id,provider,timezone FROM meal_publications WHERE active=1 AND report_date=COALESCE((SELECT report_date FROM meal_publications WHERE active=1 AND report_date=? LIMIT 1),(SELECT report_date FROM meal_publications WHERE active=1 ORDER BY collected_at DESC,id DESC LIMIT 1)) ORDER BY station,service_area_id,provider", [date])?;
        Ok(rows
            .iter()
            .map(|row| Scope {
                date: date.into(),
                station: s(row, "station").into(),
                service_area_id: s(row, "service_area_id").into(),
                provider: s(row, "provider").into(),
                timezone: s(row, "timezone").into(),
            })
            .collect())
    }
    fn sync_source(&self, id: &str, date: &str, provider: Provider) -> Result<Value> {
        let active = self.jobs.one("SELECT * FROM jobs WHERE dsp_id=? AND kind=? AND status IN ('queued','running','waiting_verification') ORDER BY created_at DESC LIMIT 1", params![id,provider.job_kind()])?;
        let mut latest = self.jobs.one("SELECT * FROM jobs WHERE dsp_id=? AND kind=? AND (json_extract(request,'$.date')=? OR request='{}') ORDER BY created_at DESC LIMIT 1", params![id,provider.job_kind(),date])?;
        if let Some(row) = &latest
            && provider == Provider::Cortex
            && let Some((prefix, _)) = s(row, "idempotency_key").rsplit_once(":flex:")
        {
            let prefix = format!("{prefix}:flex:");
            // A multi-station sync succeeds only when every station succeeds.
            if let Some(failed) = self.jobs.one("SELECT * FROM jobs WHERE dsp_id=? AND kind=? AND substr(idempotency_key,1,?)=? AND status IN ('failed','cancelled') ORDER BY CASE status WHEN 'failed' THEN 0 ELSE 1 END,created_at DESC LIMIT 1",params![id,provider.job_kind(),prefix.chars().count() as i64,prefix])? {
                latest = Some(failed);
            }
        }
        let collected = match provider {
            Provider::Paycom => self.collector(id,provider)?.one("SELECT collected_at FROM publications WHERE period_from<=? AND period_to>=? ORDER BY collected_at DESC,id DESC LIMIT 1",[date,date])?,
            Provider::Cortex => self.collector(id,provider)?.one("SELECT MAX(collected_at) collected_at FROM meal_publications WHERE report_date=? AND active=1",[date])?,
        };
        Ok(json!({
            "enabled":self.connection_for(id,provider)?["enabled"],
            "active":active.is_some(),
            "job":active.as_ref().or(latest.as_ref()).map(|row|self.public_job(row)).transpose()?,
            "collectedAt":collected.map(|row|row["collected_at"].clone()),
        }))
    }
    pub fn meal_sync_status(&self, id: &str, date: &str) -> Result<Value> {
        // Reading a calendar date is valid even when the viewer is a day ahead
        // of the DSP. Collection still validates each provider's business date.
        super::validate::date(date)?;
        let discovery = self.meal_sync_discovery(id, date)?;
        let station_available = (3..=8).contains(&discovery.station.len())
            && discovery
                .station
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        Ok(
            json!({"date":date,"scopeAvailable":station_available || !self.meal_sync_scopes(id,date)?.is_empty(),
            "paycom":self.sync_source(id,date,Provider::Paycom)?,
            "flex":self.sync_source(id,date,Provider::Cortex)?}),
        )
    }
    pub fn enqueue_meal_sync(&self, id: &str, actor: &str, key: &str, date: &str) -> Result<Value> {
        workforce::collection_date(&json!({"date":date}), s(&self.get_dsp(id)?, "timezone"))?;
        ensure(
            flag(&self.connection_for(id, Provider::Paycom)?, "enabled"),
            "meal_sync_paycom_required",
            409,
        )?;
        ensure(
            flag(&self.connection_for(id, Provider::Cortex)?, "enabled"),
            "meal_sync_flex_required",
            409,
        )?;
        // Replay the original batch even after discovery publishes its first
        // scope, or subsequent collections change the available stations.
        let prefix = format!("meal:{key}:");
        let existing = self.jobs.all("SELECT * FROM jobs WHERE dsp_id=? AND substr(idempotency_key,1,?)=? ORDER BY CASE kind WHEN 'paycom.collect' THEN 0 ELSE 1 END,idempotency_key", params![id,prefix.chars().count() as i64,prefix])?;
        let existing: Vec<_> = existing
            .into_iter()
            .filter(|row| {
                let suffix = s(row, "idempotency_key")
                    .strip_prefix(&prefix)
                    .unwrap_or("");
                suffix == "paycom"
                    || suffix.strip_prefix("flex:").is_some_and(|index| {
                        !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit())
                    })
            })
            .collect();
        if !existing.is_empty() {
            let mut jobs = Vec::new();
            for row in existing {
                let request: Value = serde_json::from_str(s(&row, "request"))?;
                ensure(s(&request, "date") == date, "idempotency_conflict", 409)?;
                jobs.push(self.public_job(&row)?);
            }
            return Ok(json!({"date":date,"jobs":jobs}));
        }
        let scopes = self.meal_sync_scopes(id, date)?;
        let mut requests = vec![(
            format!("meal:{key}:paycom"),
            Provider::Paycom,
            json!({"date":date}),
        )];
        if scopes.is_empty() {
            let discovery = self.meal_sync_discovery(id, date)?;
            ensure(
                !discovery.station.is_empty(),
                "meal_sync_scope_required",
                409,
            )?;
            discovery.scope("discovery", "discovery")?;
            requests.push((
                format!("meal:{key}:flex:0"),
                Provider::Cortex,
                serde_json::to_value(discovery)?,
            ));
        }
        for (index, scope) in scopes.iter().enumerate() {
            scope.validate()?;
            requests.push((
                format!("meal:{key}:flex:{index}"),
                Provider::Cortex,
                serde_json::to_value(scope)?,
            ));
        }
        ensure(self.jobs.one("SELECT id FROM jobs WHERE dsp_id=? AND status IN ('queued','running','waiting_verification') LIMIT 1",[id])?.is_none(),"sync_in_progress",409)?;
        let jobs = self.enqueue_batch(id, Some(actor), &requests)?;
        Ok(json!({"date":date,"jobs":jobs}))
    }
}
