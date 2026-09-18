use super::{
    Result, State,
    db::{self, Db, Store, n, s},
    ensure,
};
use rusqlite::params;
use serde::Serialize;
use serde_json::{Value, json};

// Nullable, additive columns allow an older Rust runtime to keep sending mail
// after rollback. Historical retry rows have no reliable enqueue time.
pub fn migrate(db: &Db) -> Result<()> {
    let columns = db.all("PRAGMA table_info(outbox)", [])?;
    db.transaction(|| {
        for (name, kind) in [("created_at", "INTEGER"), ("last_attempt_at", "INTEGER"), ("last_error", "TEXT")] {
            if !columns.iter().any(|c| s(c, "name") == name) {
                db.0.execute_batch(&format!("ALTER TABLE outbox ADD COLUMN {name} {kind}"))?;
            }
        }
        db.exec("UPDATE outbox SET created_at=available_at WHERE created_at IS NULL AND attempts=0 AND status='pending'", [])?;
        db.0.execute_batch("CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,available_at); CREATE INDEX IF NOT EXISTS outbox_last_attempt ON outbox(last_attempt_at DESC); CREATE INDEX IF NOT EXISTS outbox_sent ON outbox(sent_at DESC)")?;
        Ok(())
    })
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportHealth {
    pub error: Option<String>,
    pub checked_at: Option<String>,
}

pub fn transport_status(state: &State, error: Option<&str>) {
    if let Ok(mut health) = state.mail_transport.lock() {
        *health = TransportHealth {
            error: error.map(str::to_owned),
            checked_at: Some(db::iso()),
        };
    }
}

pub fn health(db: &Store, state: &State) -> Result<Value> {
    let counts = db.platform.one("SELECT count(*) FILTER (WHERE status='pending') pending,count(*) FILTER (WHERE status='failed') failed,MIN(created_at) FILTER (WHERE status='pending') oldest,count(*) FILTER (WHERE status='pending' AND created_at IS NULL) unknownAge FROM outbox", [])?.unwrap();
    let last_sent = db.platform.one(
        "SELECT sent_at FROM outbox WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
        [],
    )?;
    let last_attempt = db.platform.one("SELECT last_error,last_attempt_at FROM outbox WHERE last_attempt_at IS NOT NULL ORDER BY last_attempt_at DESC,id DESC LIMIT 1", [])?;
    let transport = state
        .mail_transport
        .lock()
        .map_err(|_| super::Error::new("mail_health_unavailable", 503))?
        .clone();
    Ok(json!({
        "enabled":db.config.mail_available(),
        "pending":n(&counts,"pending"), "failed":n(&counts,"failed"),
        "oldestPendingAgeMs":if n(&counts,"unknownAge") > 0 { None } else { counts["oldest"].as_i64().map(|t| (db::now()-t).max(0)) },
        "lastSuccessAt":last_sent.as_ref().map(|r| &r["sent_at"]),
        "lastAttemptAt":last_attempt.as_ref().and_then(|r| r["last_attempt_at"].as_i64()).map(db::at),
        "lastError":last_attempt.as_ref().map(|r| &r["last_error"]),
        "transport":transport,
    }))
}

pub fn record_delivery(db: &Store, id: &str, attempts: i64, error: Option<&str>) -> Result<()> {
    let changed = if let Some(error) = error {
        db.platform.exec("UPDATE outbox SET attempts=attempts+1,status=?,available_at=?,last_attempt_at=?,last_error=? WHERE id=? AND status='pending'", params![if attempts >= 4 { "failed" } else { "pending" },db::now()+60000*2_i64.pow(attempts.clamp(0,8) as u32),db::now(),error,id])?
    } else {
        db.platform.exec("UPDATE outbox SET status='sent',encrypted_message='',sent_at=?,last_attempt_at=?,last_error=NULL WHERE id=? AND status='pending'", params![db::iso(),db::now(),id])?
    };
    ensure(changed == 1, "email_delivery_record_missing", 500)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_migration_preserves_old_runtime_inserts_and_retry_age() {
        let db = Db(rusqlite::Connection::open_in_memory().unwrap());
        db.0.execute_batch(include_str!("platformSchema.sql"))
            .unwrap();
        db.exec("INSERT INTO outbox(id,encrypted_message,attempts,available_at) VALUES ('old','secret',2,1000)", []).unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        assert!(
            db.one("SELECT created_at FROM outbox WHERE id='old'", [])
                .unwrap()
                .unwrap()["created_at"]
                .is_null()
        );
        // Prior binaries omit the new nullable columns and remain compatible.
        db.exec("INSERT INTO outbox(id,encrypted_message,available_at) VALUES ('rollback','secret',2000)", []).unwrap();
        assert_eq!(
            db.one("SELECT count(*) n FROM outbox", [])
                .unwrap()
                .unwrap()["n"],
            2
        );
    }
}
