mod common;
use common::{audits, bootstrapped, seeded};
use dispatch_backend::{
    crypto,
    db::{self, s},
};
use serde_json::json;

#[tokio::test]
async fn concurrent_password_resets_cannot_reuse_a_consumed_token() {
    use dispatch_backend::State;
    let (_root, db, _) = bootstrapped();
    let user = db
        .platform
        .one("SELECT * FROM users WHERE email='owner@example.test'", [])
        .unwrap()
        .unwrap();
    let token = crypto::token().unwrap();
    db.platform
        .exec(
            "INSERT INTO resets(hash,user_id,user_version,expires_at) VALUES (?,?,?,?)",
            rusqlite::params![
                crypto::sha(&token),
                s(&user, "id"),
                db::n(&user, "version"),
                db::now() + 60000
            ],
        )
        .unwrap();
    let config = db.config.clone();
    drop(db);
    let state = State::new(config).unwrap();
    let (a, b) = tokio::join!(
        state.reset_password(token.clone(), "first-replacement-password".into()),
        state.reset_password(token.clone(), "second-replacement-password".into())
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(a.err().or(b.err()).unwrap().code, "reset_expired");
    assert_eq!(
        state
            .reset_password(token, "third-replacement-password".into())
            .await
            .unwrap_err()
            .code,
        "reset_expired"
    );
}

#[tokio::test]
async fn removing_a_member_deletes_their_account_and_keeps_their_name_in_the_log() {
    use dispatch_backend::{State, accounts::Auth};
    let (_root, db) = seeded();
    let one = |sql: &str| db.platform.one(sql, []).unwrap();
    let tenant = one("SELECT id FROM dsps WHERE name='Northline Logistics'").unwrap();
    let dsp = s(&tenant, "id");
    let owner = one("SELECT id FROM users WHERE platform_owner=1").unwrap();
    let member = one("SELECT id FROM users WHERE email='member@dispatch.test'").unwrap();
    let membership = one("SELECT id,role_id FROM memberships").unwrap();
    let invite = |email: &str, by: &str| {
        let raw = crypto::token().unwrap();
        db.platform.exec("INSERT INTO invitations(hash,dsp_id,email,role,role_id,expires_at,created_by) VALUES (?,?,?,'member',?,?,?)",rusqlite::params![crypto::sha(&raw),dsp,email,s(&membership,"role_id"),db::now()+60000,by]).unwrap();
        raw
    };
    db.audit(Some(s(&member, "id")), Some(dsp), "schedule.updated", "")
        .unwrap();
    db.platform
        .exec(
            "INSERT INTO sessions(hash,user_id,user_version,expires_at,created_at) VALUES ('session',?,1,?,?)",
            rusqlite::params![s(&member, "id"), db::now() + 60000, db::now()],
        )
        .unwrap();
    db.platform
        .exec(
            "INSERT INTO resets(hash,user_id,user_version,expires_at) VALUES ('reset',?,1,?)",
            rusqlite::params![s(&member, "id"), db::now() + 60000],
        )
        .unwrap();
    invite("colleague@dispatch.test", s(&member, "id"));
    let auth = Auth {
        user: serde_json::from_value(
            json!({"id":owner["id"],"email":"","firstName":"","lastName":"","platformOwner":true}),
        )
        .unwrap(),
        hash: String::new(),
        csrf: String::new(),
        raw: String::new(),
        preview: None,
    };
    let context = db.context(&auth, dsp, "members.manage").unwrap();
    db.set_role(&context, s(&membership, "id"), None).unwrap();
    for table in [
        "users WHERE email='member@dispatch.test'",
        "sessions",
        "resets",
    ] {
        assert!(one(&format!("SELECT 1 FROM {table}")).is_none(), "{table}");
    }
    assert!(one("SELECT created_by FROM invitations").is_none());
    let log = audits(&db, Some(dsp)).unwrap();
    let event = log
        .as_array()
        .unwrap()
        .iter()
        .find(|row| s(row, "action") == "schedule.updated")
        .unwrap();
    assert_eq!(s(event, "actorName"), "Jordan Ellis");
    assert!(event["actorId"].is_null());
    let platform = audits(&db, None).unwrap();
    let removal = platform
        .as_array()
        .unwrap()
        .iter()
        .find(|row| s(row, "action") == "member.removed")
        .unwrap();
    assert_eq!(s(removal, "target"), "Jordan Ellis");
    assert_eq!(removal["changes"][0]["field"], "role");
    assert!(removal["changes"][0]["to"].is_null());
    assert!(one("SELECT 1 FROM users WHERE platform_owner=1").is_some());

    let raw = invite("member@dispatch.test", s(&owner, "id"));
    let config = db.config.clone();
    drop(db);
    let state = State::new(config).unwrap();
    state
        .accept_invitation(
            raw,
            dispatch_backend::contracts::InvitationRequest {
                first_name: "Riley".into(),
                last_name: "Shaw".into(),
                password: "a-brand-new-password".into(),
                dsp_profile: None,
            },
            "127.0.0.1".into(),
        )
        .await
        .unwrap();
    let joined = state
        .read(|db| {
            db.platform.one(
                "SELECT u.id,u.first_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email='member@dispatch.test'",
                [],
            )
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s(&joined, "first_name"), "Riley");
    assert_ne!(joined["id"], member["id"]);
}
