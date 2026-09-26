use crate::{
    Result,
    db::Store,
    ensure,
    http::{
        input::{Input, Reply},
        route::{Grant, Route, Session, User, async_post, read, write},
    },
    validate as v,
};
use serde_json::json;

const RECOVERY_CODE_FORMAT: &str = "grouped-v1";

fn ensure_recovery_code_format(input: &Input) -> Result<()> {
    ensure(
        input.header("x-dispatch-recovery-code-format") == RECOVERY_CODE_FORMAT,
        "browser_update_required",
        409,
    )
}

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/auth/security/status", Session, status),
        read("/api/auth/security/passkeys", Session, passkeys),
        write(
            "/api/auth/security/passkeys/register/start",
            Session,
            passkey_register_start,
        ),
        write(
            "/api/auth/security/passkeys/register/finish",
            Session,
            passkey_register_finish,
        ),
        write(
            "/api/auth/security/passkeys/verify/start",
            Session,
            passkey_verify_start,
        ),
        write(
            "/api/auth/security/passkeys/verify/finish",
            Session,
            passkey_verify_finish,
        ),
        write(
            "/api/auth/security/passkeys/{id}/remove",
            Session,
            remove_passkey,
        ),
        write(
            "/api/auth/security/authenticator/register/start",
            Session,
            authenticator_register_start,
        ),
        write(
            "/api/auth/security/authenticator/register/finish",
            Session,
            authenticator_register_finish,
        ),
        write(
            "/api/auth/security/authenticator/verify",
            Session,
            authenticator_verify,
        ),
        write(
            "/api/auth/security/authenticator/remove",
            Session,
            remove_authenticator,
        ),
        write("/api/auth/security/recover", Session, recover),
        write("/api/auth/security/recovery-codes", Session, recovery_codes),
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
        async_post("/api/auth/security/reauthenticate", Session, reauthenticate),
    ]
}

async fn reauthenticate(
    state: std::sync::Arc<crate::State>,
    input: Input,
    access: Session,
) -> Result<Reply> {
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

fn passkey_register_start(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    Ok(Reply::json(db.passkey_register_start(user)?))
}

fn passkey_register_finish(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["credential", "name"])?;
    ensure_recovery_code_format(input)?;
    let name = v::text(&input.body, "name", 1, 60)?;
    let codes = db.passkey_register_finish(user, input.body["credential"].clone(), name)?;
    Ok(Reply::json(json!({"codes":codes})))
}

fn passkey_verify_start(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    Ok(Reply::json(db.passkey_verify_start(user)?))
}

fn passkey_verify_finish(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["credential"])?;
    db.passkey_verify_finish(user, input.body["credential"].clone())?;
    Ok(Reply::ok())
}

fn remove_passkey(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.remove_passkey(user, input.param("id"))?;
    Ok(Reply::ok())
}

fn authenticator_register_start(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    Reply::of(&db.authenticator_register_start(user)?)
}

fn authenticator_register_finish(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["code"])?;
    ensure_recovery_code_format(input)?;
    let code = v::text(&input.body, "code", 6, 6)?;
    let codes = db.authenticator_register_finish(user, code)?;
    Ok(Reply::json(json!({"codes":codes})))
}

fn authenticator_verify(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["code"])?;
    db.authenticator_verify(user, v::text(&input.body, "code", 6, 6)?)?;
    Ok(Reply::ok())
}

fn remove_authenticator(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.remove_authenticator(user)?;
    Ok(Reply::ok())
}

fn recover(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["code"])?;
    db.use_recovery_code(user, v::text(&input.body, "code", 1, 64)?)?;
    Ok(Reply::ok())
}

fn recovery_codes(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    ensure_recovery_code_format(input)?;
    Ok(Reply::json(json!({"codes":db.new_recovery_codes(user)?})))
}

fn sessions(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    db.ensure_mfa(user)?;
    Reply::of(&db.account_sessions(user)?)
}

fn revoke(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.ensure_recent(user)?;
    db.revoke_session(user, input.param("id"))?;
    Ok(Reply::ok())
}

fn revoke_others(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.ensure_recent(user)?;
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
    db.ensure_recent(user)?;
    db.platform.transaction(|| {
        db.platform
            .exec("DELETE FROM sessions WHERE user_id=?", [&user.user.id])?;
        db.audit(Some(user.actor()), None, "account.all_sessions_revoked", "")
    })?;
    Ok(Reply::signed_out(user.state.config.development))
}
