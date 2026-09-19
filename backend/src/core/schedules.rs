//! DSP-owned recurring collections. Provider databases remain rollback-compatible.
use super::{
    Error, Result,
    collectors::Provider,
    crypto,
    db::{Store, at, flag, iso, n, now, s},
    ensure, validate as v,
};
use chrono::{NaiveTime, TimeZone};
use rusqlite::params;
use serde_json::{Value, json};

const LEGACY: &str = "legacy-paycom";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS collection_schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, collection TEXT NOT NULL CHECK(collection IN ('paycom','meal_break','both')),
    cadence TEXT NOT NULL CHECK(cadence IN ('interval','daily')), interval_minutes INTEGER, local_time TEXT NOT NULL,
    anchor INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run TEXT,
    revision INTEGER NOT NULL DEFAULT 1, last_error TEXT, created_at TEXT NOT NULL
);";

fn timezone(tz: &str) -> Result<chrono_tz::Tz> {
    tz.parse().map_err(|_| Error::new("invalid_timezone", 400))
}
fn local_time(time: &str) -> Result<NaiveTime> {
    let parsed = NaiveTime::parse_from_str(time, "%H:%M")
        .map_err(|_| Error::new("invalid_schedule_time", 400))?;
    ensure(
        parsed.format("%H:%M").to_string() == time,
        "invalid_schedule_time",
        400,
    )?;
    Ok(parsed)
}
fn local_instant(date: chrono::NaiveDate, time: NaiveTime, tz: chrono_tz::Tz) -> Option<i64> {
    // A repeated local time runs once, at its first occurrence. A missing time
    // on the spring transition is skipped, rather than inventing another time.
    tz.from_local_datetime(&date.and_time(time))
        .earliest()
        .map(|d| d.timestamp_millis())
}
pub fn next_daily(time: &str, tz: &str, after: i64) -> Result<String> {
    let time = local_time(time)?;
    let tz = timezone(tz)?;
    let date = chrono::DateTime::from_timestamp_millis(after)
        .ok_or_else(|| Error::new("invalid_schedule", 400))?
        .with_timezone(&tz)
        .date_naive();
    for days in 0..4 {
        let day = date + chrono::Duration::days(days);
        if let Some(instant) = local_instant(day, time, tz)
            && instant > after
        {
            return Ok(at(instant));
        }
    }
    Err(Error::new("schedule_unresolvable", 400))
}
fn anchor(time: &str, tz: &str, after: i64) -> Result<i64> {
    let tz = timezone(tz)?;
    let date = chrono::DateTime::from_timestamp_millis(after)
        .ok_or_else(|| Error::new("invalid_schedule", 400))?
        .with_timezone(&tz)
        .date_naive();
    let time = local_time(time)?;
    // If today's anchor falls into a DST gap, start at the next valid day.
    for days in 0..4 {
        if let Some(value) = local_instant(date + chrono::Duration::days(days), time, tz) {
            return Ok(value);
        }
    }
    Err(Error::new("schedule_unresolvable", 400))
}
fn next(row: &Value, tz: &str, after: i64) -> Result<String> {
    if s(row, "cadence") == "daily" {
        return next_daily(s(row, "local_time"), tz, after);
    }
    let period = n(row, "interval_minutes") * 60000;
    ensure(period > 0, "invalid_schedule", 500)?;
    let start = n(row, "anchor");
    Ok(at(if start > after {
        start
    } else {
        start + ((after - start) / period + 1) * period
    }))
}
fn timing(value: &Value) -> Result<()> {
    v::choice(value, "cadence", &["interval", "daily"])?;
    local_time(v::text(value, "localTime", 5, 5)?)?;
    if s(value, "cadence") == "interval" {
        let minutes = v::integer(value, "intervalMinutes", 30, 1440)?;
        ensure(minutes % 30 == 0, "invalid_schedule_interval", 400)?;
    } else {
        ensure(value["intervalMinutes"].is_null(), "invalid_input", 400)?;
    }
    Ok(())
}
fn same_timing(row: &Value, value: &Value) -> bool {
    row["cadence"] == value["cadence"]
        && row["interval_minutes"] == value["intervalMinutes"]
        && row["local_time"] == value["localTime"]
}
// The fields a member can edit, compared for the audit log.
pub fn schedule_changes(before: &Value, after: &Value) -> Vec<super::db::AuditChange> {
    const FIELDS: [(&str, &str); 6] = [
        ("name", "name"),
        ("collection", "collection"),
        ("cadence", "cadence"),
        ("intervalMinutes", "interval"),
        ("localTime", "time"),
        ("enabled", "enabled"),
    ];
    let text = |value: &Value| match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    };
    FIELDS
        .iter()
        .filter(|(key, _)| before[key] != after[key])
        .map(|(key, field)| (*field, text(&before[key]), text(&after[key])))
        .collect()
}
fn public(row: &Value) -> Value {
    json!({"id":row["id"],"name":row["name"],"collection":row["collection"],
        "cadence":row["cadence"],"intervalMinutes":row["interval_minutes"],
        "localTime":row["local_time"],"enabled":flag(row,"enabled"),
        "nextRun":row["next_run"],"revision":row["revision"],"lastError":row["last_error"]})
}

impl Store {
    pub(crate) fn initialize_schedules(&self, id: &str) -> Result<()> {
        let db = self.dsp(id)?;
        db.0.execute_batch(SCHEMA)?;
        if db.setting("collectionSchedules.initialized", json!(false))? == json!(true) {
            return Ok(());
        }
        self.import_legacy_schedule(id, false)?;
        db.set("collectionSchedules.initialized", &json!(true))
    }
    pub(crate) fn import_legacy_schedule(&self, id: &str, force: bool) -> Result<()> {
        let legacy = self.schedule(id)?;
        // A fresh DSP starts empty; do not present an invented default schedule.
        if !force && !flag(&legacy, "enabled") && legacy["intervalSeconds"].is_null()
            && s(&legacy, "localTime") == "06:00"
            && self.platform.one("SELECT id FROM audit WHERE dsp_id=? AND action IN ('schedule.updated','paycom.settings_updated') LIMIT 1", [id])?.is_none()
        {
            return Ok(());
        }
        let interval = legacy["intervalSeconds"].as_i64().map(|v| v / 60);
        let zone = timezone(s(&legacy, "timezone"))?;
        let time = if interval.is_some() {
            legacy["nextRun"]
                .as_str()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|date| date.with_timezone(&zone).format("%H:%M").to_string())
                .unwrap_or_else(|| s(&legacy, "localTime").into())
        } else {
            s(&legacy, "localTime").into()
        };
        let start = legacy["nextRun"]
            .as_str()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp_millis())
            .unwrap_or(anchor(&time, s(&legacy, "timezone"), now())?);
        self.dsp(id)?.exec("INSERT INTO collection_schedules(id,name,collection,cadence,interval_minutes,local_time,anchor,enabled,next_run,created_at) VALUES (?,'Paycom sync','paycom',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET collection='paycom',cadence=excluded.cadence,interval_minutes=excluded.interval_minutes,local_time=excluded.local_time,anchor=excluded.anchor,enabled=excluded.enabled,next_run=excluded.next_run,last_error=NULL,revision=collection_schedules.revision+1",params![LEGACY,if interval.is_some(){"interval"}else{"daily"},interval,time,start,flag(&legacy,"enabled"),legacy["nextRun"].as_str(),iso()])?;
        Ok(())
    }
    fn mirror_legacy_schedule(&self, id: &str, row: &Value) -> Result<()> {
        if s(row, "id") != LEGACY {
            return Ok(());
        }
        let db = self.collector(id, Provider::Paycom)?;
        db.transaction(|| {
            db.exec("UPDATE schedules SET enabled=?,local_time=?,timezone=?,next_run=? WHERE provider='paycom'",params![flag(row,"enabled") && s(row,"collection")!="meal_break",s(row,"local_time"),s(&self.get_dsp(id)?,"timezone"),row["next_run"].as_str()])?;
            if s(row,"cadence")=="interval" {
                db.set("paycom.syncIntervalSeconds",&json!(n(row,"interval_minutes")*60))?;
            } else { db.exec("DELETE FROM settings WHERE key='paycom.syncIntervalSeconds'",[])?; }
            Ok(())
        })
    }
    pub fn collection_schedules(&self, id: &str) -> Result<Value> {
        let dsp = self.get_dsp(id)?;
        let rows = self.dsp(id)?.all(
            "SELECT * FROM collection_schedules ORDER BY created_at,id",
            [],
        )?;
        Ok(
            json!({"timezone":dsp["timezone"],"dspName":dsp["name"],"schedules":rows.iter().map(public).collect::<Vec<_>>()}),
        )
    }
    pub fn collection_schedule(&self, id: &str, schedule: &str) -> Result<Value> {
        Ok(public(&self.schedule_row(id, schedule)?))
    }
    fn schedule_row(&self, id: &str, schedule: &str) -> Result<Value> {
        self.dsp(id)?
            .one("SELECT * FROM collection_schedules WHERE id=?", [schedule])?
            .ok_or_else(|| Error::new("schedule_not_found", 404))
    }
    fn check_schedule_sources(&self, id: &str, collection: &str) -> Result<()> {
        if collection != "meal_break" {
            ensure(
                flag(&self.connection_for(id, Provider::Paycom)?, "enabled"),
                "schedule_paycom_required",
                409,
            )?;
        }
        if collection != "paycom" {
            ensure(
                flag(&self.connection_for(id, Provider::Cortex)?, "enabled"),
                "schedule_meals_required",
                409,
            )?;
            let tz = timezone(s(&self.get_dsp(id)?, "timezone"))?;
            let date = chrono::Utc::now()
                .with_timezone(&tz)
                .format("%Y-%m-%d")
                .to_string();
            ensure(
                !self.meal_sync_scopes(id, &date)?.is_empty(),
                "schedule_scope_required",
                409,
            )?;
        }
        Ok(())
    }
    pub fn preview_schedule(&self, id: &str, value: &Value) -> Result<Value> {
        v::fields(
            value,
            &["scheduleId", "cadence", "intervalMinutes", "localTime"],
        )?;
        timing(value)?;
        let dsp = self.get_dsp(id)?;
        let tz = s(&dsp, "timezone");
        let before = if value.get("scheduleId").is_some() {
            Some(self.schedule_row(id, v::text(value, "scheduleId", 1, 128)?)?)
        } else {
            None
        };
        let start = match before.as_ref().filter(|row| same_timing(row, value)) {
            Some(row) => n(row, "anchor"),
            None => anchor(s(value, "localTime"), tz, now())?,
        };
        let row = json!({"cadence":value["cadence"],"interval_minutes":value["intervalMinutes"],"local_time":value["localTime"],"anchor":start});
        Ok(json!({"nextRun":next(&row,tz,now())?}))
    }
    pub fn save_collection_schedule(
        &self,
        id: &str,
        schedule: Option<&str>,
        value: &Value,
    ) -> Result<Value> {
        v::fields(
            value,
            &[
                "name",
                "collection",
                "cadence",
                "intervalMinutes",
                "localTime",
                "enabled",
                "revision",
            ],
        )?;
        let name = v::name(value, "name", 60)?;
        let collection = v::choice(value, "collection", &["paycom", "meal_break", "both"])?;
        timing(value)?;
        let enabled = v::boolean(value, "enabled")?;
        let before = schedule.map(|key| self.schedule_row(id, key)).transpose()?;
        if let Some(before) = &before {
            ensure(
                n(before, "revision") == v::integer(value, "revision", 1, i64::MAX)?,
                "schedule_changed",
                409,
            )?;
        } else {
            ensure(
                n(
                    &self
                        .dsp(id)?
                        .one("SELECT count(*) count FROM collection_schedules", [])?
                        .unwrap(),
                    "count",
                ) < 50,
                "schedule_limit",
                409,
            )?;
        }
        if enabled {
            self.check_schedule_sources(id, collection)?;
        }
        let dsp = self.get_dsp(id)?;
        let tz = s(&dsp, "timezone");
        let key = schedule
            .map(str::to_owned)
            .unwrap_or(crypto::id("schedule")?);
        let same_timing = before.as_ref().is_some_and(|r| same_timing(r, value));
        let start = if same_timing {
            n(before.as_ref().unwrap(), "anchor")
        } else {
            anchor(s(value, "localTime"), tz, now())?
        };
        let row = json!({"cadence":value["cadence"],"interval_minutes":value["intervalMinutes"],"local_time":value["localTime"],"anchor":start});
        let next_run = if !enabled {
            None
        } else if same_timing && before.as_ref().is_some_and(|r| flag(r, "enabled")) {
            before
                .as_ref()
                .and_then(|r| r["next_run"].as_str())
                .map(str::to_owned)
                .or(Some(next(&row, tz, now())?))
        } else {
            Some(next(&row, tz, now())?)
        };
        self.dsp(id)?.exec("INSERT INTO collection_schedules(id,name,collection,cadence,interval_minutes,local_time,anchor,enabled,next_run,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,collection=excluded.collection,cadence=excluded.cadence,interval_minutes=excluded.interval_minutes,local_time=excluded.local_time,anchor=excluded.anchor,enabled=excluded.enabled,next_run=excluded.next_run,last_error=NULL,revision=collection_schedules.revision+1",params![key,name,collection,s(value,"cadence"),value["intervalMinutes"].as_i64(),s(value,"localTime"),start,enabled,next_run,iso()])?;
        let row = self.schedule_row(id, &key)?;
        self.mirror_legacy_schedule(id, &row)?;
        Ok(public(&row))
    }
    pub fn enable_collection_schedule(
        &self,
        id: &str,
        schedule: &str,
        value: &Value,
    ) -> Result<Value> {
        v::fields(value, &["revision", "enabled"])?;
        let row = self.schedule_row(id, schedule)?;
        let mut input = public(&row);
        input
            .as_object_mut()
            .unwrap()
            .retain(|key, _| !["id", "nextRun", "lastError"].contains(&key.as_str()));
        input["revision"] = value["revision"].clone();
        input["enabled"] = json!(v::boolean(value, "enabled")?);
        self.save_collection_schedule(id, Some(schedule), &input)
    }
    pub fn delete_collection_schedule(
        &self,
        id: &str,
        schedule: &str,
        value: &Value,
    ) -> Result<()> {
        v::fields(value, &["revision"])?;
        let mut row = self.schedule_row(id, schedule)?;
        ensure(
            n(&row, "revision") == v::integer(value, "revision", 1, i64::MAX)?,
            "schedule_changed",
            409,
        )?;
        self.dsp(id)?
            .exec("DELETE FROM collection_schedules WHERE id=?", [schedule])?;
        row["enabled"] = json!(false);
        row["next_run"] = Value::Null;
        self.mirror_legacy_schedule(id, &row)
    }
    pub(crate) fn pause_provider_schedules(&self, id: &str, provider: Provider) -> Result<()> {
        let target = if provider == Provider::Paycom {
            "paycom"
        } else {
            "meal_break"
        };
        self.dsp(id)?.exec("UPDATE collection_schedules SET enabled=0,next_run=NULL,last_error=NULL,revision=revision+1 WHERE enabled=1 AND collection IN (?, 'both')",[target])?;
        if let Some(row) = self
            .dsp(id)?
            .one("SELECT * FROM collection_schedules WHERE id=?", [LEGACY])?
        {
            self.mirror_legacy_schedule(id, &row)?;
        }
        Ok(())
    }
    pub(crate) fn retime_schedules(&self, id: &str, tz: &str) -> Result<()> {
        let db = self.dsp(id)?;
        db.transaction(|| {
            for mut row in db.all("SELECT * FROM collection_schedules",[])? {
                let start=anchor(s(&row,"local_time"),tz,now())?;
                row["anchor"]=json!(start);
                let deadline=if flag(&row,"enabled"){Some(next(&row,tz,now())?)}else{None};
                db.exec("UPDATE collection_schedules SET anchor=?,next_run=?,last_error=NULL,revision=revision+1 WHERE id=?",params![start,deadline,s(&row,"id")])?;
            }
            Ok(())
        })
    }
    pub fn schedule_deadlines(&self) -> Result<Vec<(String, i64)>> {
        let mut deadlines = Vec::new();
        for dsp in self.platform.all(
            "SELECT id FROM dsps WHERE status='active' AND environment=?",
            [&self.config.environment],
        )? {
            let id = s(&dsp, "id");
            if let Some(row)=self.dsp(id)?.one("SELECT next_run FROM collection_schedules WHERE enabled=1 ORDER BY next_run LIMIT 1",[])? {
                let deadline=row["next_run"].as_str().and_then(|v|chrono::DateTime::parse_from_rfc3339(v).ok()).map_or(0,|d|d.timestamp_millis());
                deadlines.push((id.into(),deadline));
            }
        }
        Ok(deadlines)
    }
    fn enqueue_schedule(&self, id: &str, row: &Value) -> Result<()> {
        let collection = s(row, "collection");
        let key = format!("schedule:{}:{}:", s(row, "id"), s(row, "next_run"));
        // enqueue_batch commits all requests together. If any exists, this exact
        // occurrence already committed; do not rebuild date/scopes after a restart.
        if self
            .jobs
            .one(
                "SELECT id FROM jobs WHERE dsp_id=? AND substr(idempotency_key,1,?)=? LIMIT 1",
                params![id, key.len() as i64, key],
            )?
            .is_some()
        {
            return Ok(());
        }
        self.check_schedule_sources(id, collection)?;
        let mut requests = Vec::new();
        if collection != "meal_break" {
            requests.push((format!("{key}paycom"), Provider::Paycom, json!({})));
        }
        if collection != "paycom" {
            let tz = timezone(s(&self.get_dsp(id)?, "timezone"))?;
            let date = chrono::Utc::now()
                .with_timezone(&tz)
                .format("%Y-%m-%d")
                .to_string();
            for (index, scope) in self.meal_sync_scopes(id, &date)?.iter().enumerate() {
                scope.validate()?;
                requests.push((
                    format!("{key}flex:{index}"),
                    Provider::Cortex,
                    serde_json::to_value(scope)?,
                ));
            }
        }
        // Other collections finish before another recurring batch enters the queue.
        ensure(self.jobs.one("SELECT id FROM jobs WHERE dsp_id=? AND status IN ('queued','running','waiting_verification') LIMIT 1",[id])?.is_none(),"sync_in_progress",409)?;
        self.enqueue_batch(id, None, &requests)?;
        Ok(())
    }
    pub fn schedule_due(&self, id: &str) -> Result<Option<i64>> {
        let dsp = self.get_dsp(id)?;
        if s(&dsp, "status") != "active" || s(&dsp, "environment") != self.config.environment {
            return Ok(None);
        }
        let db = self.dsp(id)?;
        let mut earliest = None;
        for mut row in db.all(
            "SELECT * FROM collection_schedules WHERE enabled=1 ORDER BY next_run,id",
            [],
        )? {
            let pending = row["next_run"].as_str().map(str::to_owned);
            if pending.as_ref().is_some_and(|value| value <= &iso()) {
                if let Err(error) = self.enqueue_schedule(id, &row) {
                    db.exec(
                        "UPDATE collection_schedules SET last_error=? WHERE id=?",
                        [&error.code, s(&row, "id")],
                    )?;
                    let retry = now() + 60000;
                    earliest = Some(earliest.map_or(retry, |v: i64| v.min(retry)));
                    continue;
                }
                row["next_run"] = Value::Null;
            }
            let deadline = row["next_run"].as_str().map(str::to_owned).unwrap_or(next(
                &row,
                s(&dsp, "timezone"),
                now(),
            )?);
            db.exec(
                "UPDATE collection_schedules SET next_run=?,last_error=NULL WHERE id=?",
                [&deadline, s(&row, "id")],
            )?;
            row["next_run"] = json!(deadline);
            self.mirror_legacy_schedule(id, &row)?;
            let ms = chrono::DateTime::parse_from_rfc3339(&deadline)
                .map_err(|_| Error::new("invalid_schedule", 500))?
                .timestamp_millis();
            earliest = Some(earliest.map_or(ms, |v: i64| v.min(ms)));
        }
        Ok(earliest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn ms(value: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
    }
    fn setup() -> (tempfile::TempDir, Store, String) {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = super::super::config::Config::load().unwrap();
        config.root = root.path().into();
        let db = Store::initialize(config).unwrap();
        let id = crypto::id("dsp").unwrap();
        db.platform.exec("INSERT INTO dsps(id,name,environment,status,timezone,created_at) VALUES (?,'Schedule test','preview','provisioning','America/Chicago',?)",[&id,&iso()]).unwrap();
        db.provision(&id).unwrap();
        db.collector(&id, Provider::Paycom)
            .unwrap()
            .exec("UPDATE connections SET enabled=1", [])
            .unwrap();
        (root, db, id)
    }
    fn input(collection: &str) -> Value {
        json!({"name":"Collection","collection":collection,"cadence":"interval","intervalMinutes":120,"localTime":"00:00","enabled":true})
    }
    fn meals(db: &Store, id: &str) {
        db.collector(id, Provider::Cortex)
            .unwrap()
            .exec("UPDATE connections SET enabled=1", [])
            .unwrap();
        let scope = super::super::meals::Scope {
            date: "2026-01-10".into(),
            station: "DEMO1".into(),
            service_area_id: "area-demo".into(),
            provider: "provider-demo".into(),
            timezone: "America/Chicago".into(),
        };
        db.publish_meals(
            id,
            "seed-meals",
            &super::super::meals::fixture(&scope),
            &scope,
        )
        .unwrap();
    }
    fn due(db: &Store, id: &str, key: &str, deadline: &str) {
        db.dsp(id)
            .unwrap()
            .exec(
                "UPDATE collection_schedules SET next_run=? WHERE id=?",
                [deadline, key],
            )
            .unwrap();
    }
    #[test]
    fn daily_time_respects_timezone_and_runs_once_across_dst() {
        assert_eq!(
            next_daily("06:00", "America/Chicago", ms("2026-01-10T13:00:00Z")).unwrap(),
            "2026-01-11T12:00:00.000Z"
        );
        assert_eq!(
            next_daily("02:30", "America/New_York", ms("2026-03-08T05:00:00Z")).unwrap(),
            "2026-03-09T06:30:00.000Z"
        );
        assert_eq!(
            next_daily("01:30", "America/New_York", ms("2026-11-01T05:31:00Z")).unwrap(),
            "2026-11-02T06:30:00.000Z"
        );
        assert!(next_daily("24:00", "UTC", 0).is_err());
        assert!(next_daily("1:00", "UTC", 0).is_err());
    }
    #[test]
    fn intervals_keep_their_anchor_after_delays_and_restarts() {
        let row = json!({"cadence":"interval","interval_minutes":120,"anchor":ms("2026-01-10T08:00:00Z")});
        assert_eq!(
            next(&row, "UTC", ms("2026-01-10T10:17:49Z")).unwrap(),
            "2026-01-10T12:00:00.000Z"
        );
        assert_eq!(
            next(&row, "UTC", ms("2026-01-15T11:59:00Z")).unwrap(),
            "2026-01-15T12:00:00.000Z"
        );
        assert_eq!(
            next(&row, "UTC", ms("2026-01-10T07:00:00Z")).unwrap(),
            "2026-01-10T08:00:00.000Z"
        );
    }
    #[test]
    fn resuming_preview_preserves_the_saved_interval_anchor() {
        let (_root, db, id) = setup();
        let mut value = input("paycom");
        value["intervalMinutes"] = json!(300);
        value["enabled"] = json!(false);
        let saved = db.save_collection_schedule(&id, None, &value).unwrap();
        let key = s(&saved, "id");
        // Simulate an interval created on a prior day. Five hours does not
        // divide into a day, so anchoring anew would change its future runs.
        let old_anchor = anchor("00:00", "America/Chicago", now()).unwrap() - 86400000;
        db.dsp(&id)
            .unwrap()
            .exec(
                "UPDATE collection_schedules SET anchor=? WHERE id=?",
                params![old_anchor, key],
            )
            .unwrap();
        let preview = db.preview_schedule(&id, &json!({"scheduleId":key,"cadence":"interval","intervalMinutes":300,"localTime":"00:00"})).unwrap();
        let resumed = db
            .enable_collection_schedule(&id, key, &json!({"revision":1,"enabled":true}))
            .unwrap();
        assert_eq!(preview["nextRun"], resumed["nextRun"]);
        assert_eq!((ms(s(&preview, "nextRun")) - old_anchor) % (300 * 60000), 0);
        let changed = db.preview_schedule(&id, &json!({"scheduleId":key,"cadence":"daily","intervalMinutes":null,"localTime":"06:00"})).unwrap();
        assert_eq!(
            changed["nextRun"],
            next_daily("06:00", "America/Chicago", now()).unwrap()
        );
    }
    #[test]
    fn migration_preserves_the_legacy_interval_and_does_not_resurrect_deletion() {
        let (_root, db, id) = setup();
        db.dsp(&id)
            .unwrap()
            .exec(
                "DELETE FROM settings WHERE key='collectionSchedules.initialized'",
                [],
            )
            .unwrap();
        let legacy = db.collector(&id, Provider::Paycom).unwrap();
        legacy
            .set("paycom.syncIntervalSeconds", &json!(1800))
            .unwrap();
        legacy
            .exec(
                "UPDATE schedules SET enabled=1,next_run='2099-01-01T00:00:00.000Z'",
                [],
            )
            .unwrap();
        db.initialize_schedules(&id).unwrap();
        let schedules = db.collection_schedules(&id).unwrap();
        let row = &schedules["schedules"][0];
        assert_eq!(row["intervalMinutes"], 30);
        assert_eq!(row["nextRun"], "2099-01-01T00:00:00.000Z");
        assert_eq!(row["enabled"], true);
        db.delete_collection_schedule(&id, LEGACY, &json!({"revision":1}))
            .unwrap();
        db.initialize_schedules(&id).unwrap();
        assert_eq!(
            db.collection_schedules(&id).unwrap()["schedules"],
            json!([])
        );
        assert!(!flag(&db.schedule(&id).unwrap(), "enabled"));
    }
    #[test]
    fn each_collection_target_queues_the_correct_jobs_and_replay_is_idempotent() {
        for collection in ["paycom", "meal_break", "both"] {
            let (_root, db, id) = setup();
            meals(&db, &id);
            let row = db
                .save_collection_schedule(&id, None, &input(collection))
                .unwrap();
            let key = s(&row, "id");
            let deadline = "2026-01-01T00:00:00.000Z";
            due(&db, &id, key, deadline);
            let next = db.schedule_due(&id).unwrap().unwrap();
            assert!(next > now());
            let jobs = db.jobs.all("SELECT * FROM jobs", []).unwrap();
            assert_eq!(jobs.len(), if collection == "both" { 2 } else { 1 });
            assert_eq!(
                jobs.iter()
                    .filter(|j| s(j, "kind") == "paycom.collect")
                    .count(),
                usize::from(collection != "meal_break")
            );
            for job in jobs
                .iter()
                .filter(|j| s(j, "kind") == "cortex.meal_breaks.collect")
            {
                let request: Value = serde_json::from_str(s(job, "request")).unwrap();
                assert_eq!(request["station"], "DEMO1");
                assert_eq!(
                    request["date"],
                    chrono::Utc::now()
                        .with_timezone(&chrono_tz::America::Chicago)
                        .format("%Y-%m-%d")
                        .to_string()
                );
            }
            due(&db, &id, key, deadline); // Crash after the batch committed, before advancing the schedule.
            db.schedule_due(&id).unwrap();
            assert_eq!(
                db.jobs.all("SELECT id FROM jobs", []).unwrap().len(),
                jobs.len()
            );
            assert_eq!(
                db.schedule_row(&id, key).unwrap()["last_error"],
                Value::Null
            );
        }
    }
    #[test]
    fn blocked_and_overlapping_schedules_never_start_half_a_batch() {
        let (_root, db, id) = setup();
        meals(&db, &id);
        let first = db
            .save_collection_schedule(&id, None, &input("paycom"))
            .unwrap();
        let second = db
            .save_collection_schedule(&id, None, &input("both"))
            .unwrap();
        due(&db, &id, s(&first, "id"), "2026-01-01T00:00:00.000Z");
        due(&db, &id, s(&second, "id"), "2026-01-02T00:00:00.000Z");
        db.schedule_due(&id).unwrap();
        assert_eq!(db.jobs.all("SELECT id FROM jobs", []).unwrap().len(), 1);
        assert_eq!(
            db.schedule_row(&id, s(&second, "id")).unwrap()["last_error"],
            "sync_in_progress"
        );
        db.jobs
            .exec("UPDATE jobs SET status='succeeded'", [])
            .unwrap();
        db.collector(&id, Provider::Cortex)
            .unwrap()
            .exec("UPDATE connections SET enabled=0", [])
            .unwrap();
        db.schedule_due(&id).unwrap();
        assert_eq!(db.jobs.all("SELECT id FROM jobs", []).unwrap().len(), 1);
        assert_eq!(
            db.schedule_row(&id, s(&second, "id")).unwrap()["last_error"],
            "schedule_meals_required"
        );
        db.pause_provider_schedules(&id, Provider::Cortex).unwrap();
        assert!(!flag(
            &db.schedule_row(&id, s(&second, "id")).unwrap(),
            "enabled"
        ));
        assert!(flag(
            &db.schedule_row(&id, s(&first, "id")).unwrap(),
            "enabled"
        ));
    }
    #[test]
    fn timezone_changes_recompute_deadlines_and_stale_edits_are_rejected() {
        let (_root, db, id) = setup();
        let mut value = input("paycom");
        value["cadence"] = json!("daily");
        value["intervalMinutes"] = Value::Null;
        value["localTime"] = json!("06:00");
        let row = db.save_collection_schedule(&id, None, &value).unwrap();
        db.retime_schedules(&id, "Asia/Tokyo").unwrap();
        let changed = db.schedule_row(&id, s(&row, "id")).unwrap();
        assert_eq!(
            changed["next_run"],
            next_daily("06:00", "Asia/Tokyo", now()).unwrap()
        );
        value["revision"] = json!(1);
        assert_eq!(
            db.save_collection_schedule(&id, Some(s(&row, "id")), &value)
                .unwrap_err()
                .code,
            "schedule_changed"
        );
    }
}
