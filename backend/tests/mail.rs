//! The platform's mail log: what an email was for, and what became of its invitation.
mod common;
use common::{audits, seeded};
use dispatch_backend::{db::now, mail};
use rusqlite::params;

#[test]
fn the_log_follows_an_invitation_and_failed_mail_can_be_retried_or_discarded() {
    let (_root, db) = seeded();
    let row = |sql: &str| db.platform.one(sql, []).unwrap().unwrap();
    let dsp = row("SELECT id FROM dsps WHERE name='Northline Logistics'");
    let owner = row("SELECT user_id id FROM memberships WHERE role='member' LIMIT 1");
    let role = row("SELECT role_id id FROM memberships WHERE role='member' LIMIT 1");
    db.platform
        .exec(
            "INSERT INTO invitations(hash,dsp_id,email,role,role_id,expires_at,created_by,used_at) \
             VALUES ('hash-1',?,'new@example.test','member',?,?,?,?)",
            params![
                dsp["id"].as_str(),
                role["id"].as_str(),
                now() + 1000,
                owner["id"].as_str(),
                now()
            ],
        )
        .unwrap();
    for (id, status, kind, hash) in [
        ("mail_sent", "sent", Some("invitation"), Some("hash-1")),
        ("mail_failed", "failed", None, None),
    ] {
        db.platform
            .exec(
                "INSERT INTO outbox(id,encrypted_message,status,attempts,available_at,created_at,\
                 kind,invitation_hash) VALUES (?,'',?,5,?3,?3,?,?)",
                params![id, status, now(), kind, hash],
            )
            .unwrap();
    }
    let actor = owner["id"].as_str().unwrap();
    let log = mail::log(&db).unwrap();
    let sent = log.iter().find(|m| m.id == "mail_sent").unwrap();
    assert_eq!(sent.recipient.as_deref(), Some("new@example.test"));
    assert_eq!(sent.dsp_name.as_deref(), Some("Northline Logistics"));
    assert!(sent.accepted_at.is_some() && sent.invited_by.is_some());
    assert!(!sent.owner && sent.setup_complete.is_none());
    let failed = log.iter().find(|m| m.id == "mail_failed").unwrap();
    assert!(failed.kind.is_none() && failed.recipient.is_none());

    assert_eq!(
        mail::retry(&db, actor, "mail_sent").unwrap_err().code,
        "email_not_failed"
    );
    mail::retry(&db, actor, "mail_failed").unwrap();
    let retried = mail::log(&db).unwrap();
    let retried = retried.iter().find(|m| m.id == "mail_failed").unwrap();
    assert_eq!((retried.status.as_str(), retried.attempts), ("pending", 0));
    assert!(retried.next_attempt_at.is_some());
    assert_eq!(
        mail::discard(&db, actor, "mail_failed").unwrap_err().code,
        "email_not_failed"
    );
    db.platform
        .exec(
            "UPDATE outbox SET status='failed' WHERE id='mail_failed'",
            [],
        )
        .unwrap();
    mail::discard(&db, actor, "mail_failed").unwrap();
    assert!(
        mail::log(&db)
            .unwrap()
            .iter()
            .all(|m| m.id != "mail_failed")
    );
    let recorded: Vec<String> = audits(&db, None)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["action"].as_str().unwrap().to_owned())
        .filter(|action| action.starts_with("mail."))
        .collect();
    assert_eq!(recorded, ["mail.discarded", "mail.retried"]);
}
