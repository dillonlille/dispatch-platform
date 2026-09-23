use crate::{
    Result,
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Route, Session, User, read, write},
    },
    validate as v,
};
use serde_json::json;

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/auth/security/status", Session, status),
        read("/api/auth/security/passkeys", Session, passkeys),
        write("/api/auth/security/register/start", Session, register_start),
        write(
            "/api/auth/security/register/finish",
            Session,
            register_finish,
        ),
        write("/api/auth/security/verify/start", Session, verify_start),
        write("/api/auth/security/verify/finish", Session, verify_finish),
        write("/api/auth/security/recover", Session, recover),
        write("/api/auth/security/recovery-codes", Session, recovery_codes),
        write(
            "/api/auth/security/passkeys/{id}/remove",
            Session,
            remove_passkey,
        ),
        read("/api/auth/security/sessions", Session, sessions),
        write("/api/auth/security/sessions/{id}/revoke", Session, revoke),
        write(
            "/api/auth/security/sessions/revoke-others",
            Session,
            revoke_others,
        ),
        write(
            "/api/auth/security/sessions/revoke-all",
            Session,
            revoke_all,
        ),
        crate::http::route::async_post(
            "/api/auth/security/reauthenticate",
            Session,
            reauthenticate,
        ),
    ]
}
async fn reauthenticate(
    state: std::sync::Arc<crate::State>,
    input: Input,
    access: Session,
) -> Result<Reply> {
    use crate::http::route::Grant;
    v::fields(&input.body, &["password"])?;
    let password = v::text(&input.body, "password", 1, 128)?.to_owned();
    let ip = input.ip.clone();
    let auth = state.read(move |db| access.authorize(db, &input)).await?;
    state.reauthenticate(auth, password, ip).await?;
    Ok(Reply::ok())
}
fn status(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    Reply::of(&db.security_status(user)?)
}
fn passkeys(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    db.ensure_mfa(user)?;
    Reply::of(&db.passkey_list(user)?)
}
fn register_start(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    Ok(Reply::json(db.passkey_register_start(user)?))
}
fn register_finish(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["credential", "name"])?;
    let name = v::text(&input.body, "name", 1, 60)?;
    let codes = db.passkey_register_finish(user, input.body["credential"].clone(), name)?;
    Ok(Reply::json(json!({"codes":codes})))
}
fn verify_start(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    Ok(Reply::json(db.passkey_verify_start(user)?))
}
fn verify_finish(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["credential"])?;
    db.passkey_verify_finish(user, input.body["credential"].clone())?;
    Ok(Reply::ok())
}
fn recover(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["code"])?;
    db.use_recovery_code(user, v::text(&input.body, "code", 43, 43)?)?;
    Ok(Reply::ok())
}
fn recovery_codes(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    Ok(Reply::json(json!({"codes":db.new_recovery_codes(user)?})))
}
fn remove_passkey(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.remove_passkey(user, input.param("id"))?;
    Ok(Reply::ok())
}
fn sessions(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    db.ensure_mfa(user)?;
    Reply::of(&db.account_sessions(user)?)
}
fn revoke(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.ensure_mfa(user)?;
    db.revoke_session(user, input.param("id"))?;
    Ok(Reply::ok())
}
fn revoke_others(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.ensure_mfa(user)?;
    db.revoke_other_sessions(user)?;
    db.audit(
        Some(user.actor()),
        None,
        "account.other_sessions_revoked",
        "",
    )?;
    Ok(Reply::ok())
}
fn revoke_all(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.ensure_mfa(user)?;
    db.platform.transaction(|| {
        db.platform
            .exec("DELETE FROM sessions WHERE user_id=?", [&user.user.id])?;
        db.audit(Some(user.actor()), None, "account.all_sessions_revoked", "")
    })?;
    Ok(Reply::signed_out(user.state.config.development))
}
