use crate::{
    Result, State,
    contracts::MailMessage,
    db::{self, Store, flag, n},
    ensure,
};
use rusqlite::params;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;

mod delivery;
pub mod templates;
pub use delivery::mailer;

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
    let counts = db.platform.one("SELECT count(*) FILTER (WHERE status='pending') \
        pending,count(*) FILTER (WHERE status='failed') failed,MIN(created_at) FILTER (WHERE \
        status='pending') oldest,count(*) FILTER (WHERE status='pending' AND created_at IS NULL) unknownAge FROM outbox", [])?.unwrap();
    let last_sent = db.platform.one(
        "SELECT sent_at FROM outbox WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
        [],
    )?;
    let last_attempt = db.platform.one(
        "SELECT last_error,last_attempt_at FROM outbox WHERE \
        last_attempt_at IS NOT NULL ORDER BY last_attempt_at DESC,id DESC LIMIT 1",
        [],
    )?;
    let transport = state
        .mail_transport
        .lock()
        .map_err(|_| crate::Error::new("mail_health_unavailable", 503))?
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
        db.platform.exec(
            "UPDATE outbox SET \
            attempts=attempts+1,status=?,available_at=?,last_attempt_at=?,last_error=? WHERE \
            id=? AND status='pending'",
            params![
                if attempts >= 4 { "failed" } else { "pending" },
                db::now() + 60000 * 2_i64.pow(attempts.clamp(0, 8) as u32),
                db::now(),
                error,
                id
            ],
        )?
    } else {
        db.platform.exec(
            "UPDATE outbox SET \
            status='sent',encrypted_message='',sent_at=?,last_attempt_at=?,last_error=NULL \
            WHERE id=? AND status='pending'",
            params![db::iso(), db::now(), id],
        )?
    };
    ensure(changed == 1, "email_delivery_record_missing", 500)
}

const LOG: &str = "SELECT o.id,o.kind,o.status,o.attempts,o.created_at,o.sent_at,\
    o.last_attempt_at,o.available_at,o.last_error,COALESCE(i.email,u.email) recipient,\
    r.name role,COALESCE(r.system,0) owner,d.id dsp_id,d.name dsp_name,i.used_at,\
    CASE WHEN c.platform_owner=0 THEN c.first_name||' '||c.last_name END invited_by \
    FROM outbox o LEFT JOIN invitations i ON i.hash=o.invitation_hash \
    LEFT JOIN users u ON u.id=o.user_id LEFT JOIN dsps d ON d.id=i.dsp_id \
    LEFT JOIN roles r ON r.id=i.role_id LEFT JOIN users c ON c.id=i.created_by \
    ORDER BY COALESCE(o.created_at,0) DESC,o.id DESC LIMIT 200";

/// The newest 200 messages, each with what became of the invitation it carried.
pub fn log(db: &Store) -> Result<Vec<MailMessage>> {
    let mut setup: HashMap<String, bool> = HashMap::new();
    db.platform
        .all(LOG, [])?
        .into_iter()
        .map(|row| {
            let text = |key: &str| row[key].as_str().map(str::to_owned);
            let at = |key: &str| row[key].as_i64().map(db::at);
            let owner = row["owner"].as_i64() == Some(1);
            let setup_complete = match (owner, row["dsp_id"].as_str()) {
                (true, Some(dsp)) => Some(match setup.get(dsp) {
                    Some(done) => *done,
                    None => {
                        let done = !flag(&db.profile(dsp)?, "setupRequired");
                        setup.insert(dsp.to_owned(), done);
                        done
                    }
                }),
                _ => None,
            };
            let pending = row["status"] == "pending";
            Ok(MailMessage {
                id: text("id").unwrap_or_default(),
                kind: text("kind"),
                status: text("status").unwrap_or_default(),
                attempts: row["attempts"].as_i64().unwrap_or(0),
                queued_at: at("created_at"),
                sent_at: text("sent_at"),
                last_attempt_at: at("last_attempt_at"),
                next_attempt_at: if pending { at("available_at") } else { None },
                last_error: text("last_error"),
                recipient: text("recipient"),
                role: text("role"),
                owner,
                dsp_name: text("dsp_name"),
                invited_by: text("invited_by"),
                accepted_at: at("used_at"),
                setup_complete,
            })
        })
        .collect()
}

const RECIPIENT: &str = "SELECT COALESCE(i.email,u.email) recipient FROM outbox o \
    LEFT JOIN invitations i ON i.hash=o.invitation_hash LEFT JOIN users u ON u.id=o.user_id \
    WHERE o.id=? AND o.status='failed'";

/// Changes a message that ran out of attempts, and records who did it and to whose mail.
fn change_failed(
    db: &Store,
    actor: &str,
    id: &str,
    action: &str,
    change: impl FnOnce() -> Result<usize>,
) -> Result<()> {
    db.platform.transaction(|| {
        let row = db.platform.one(RECIPIENT, [id])?;
        ensure(row.is_some(), "email_not_failed", 409)?;
        let recipient = row.as_ref().and_then(|r| r["recipient"].as_str());
        change()?;
        db.audit_with(Some(actor), None, action, "", recipient, &[])
    })
}

/// Gives a message that ran out of attempts a fresh set, starting now.
pub fn retry(db: &Store, actor: &str, id: &str) -> Result<()> {
    change_failed(db, actor, id, "mail.retried", || {
        db.platform.exec(
            "UPDATE outbox SET status='pending',attempts=0,available_at=?,last_error=NULL \
             WHERE id=?",
            params![db::now(), id],
        )
    })
}

/// Drops a message that ran out of attempts, along with its encrypted content.
pub fn discard(db: &Store, actor: &str, id: &str) -> Result<()> {
    change_failed(db, actor, id, "mail.discarded", || {
        db.platform.exec("DELETE FROM outbox WHERE id=?", [id])
    })
}
