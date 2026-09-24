use crate::{
    Result,
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Route, Session, User, read, write},
    },
    validate as v,
};

pub fn routes() -> Vec<Route> {
    vec![
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
    ]
}
fn sessions(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    Reply::of(&db.account_sessions(user)?)
}
fn revoke(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.revoke_session(user, input.param("id"))?;
    Ok(Reply::ok())
}
fn revoke_others(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
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
    db.platform.transaction(|| {
        db.platform
            .exec("DELETE FROM sessions WHERE user_id=?", [&user.user.id])?;
        db.audit(Some(user.actor()), None, "account.all_sessions_revoked", "")
    })?;
    Ok(Reply::signed_out(user.state.config.development))
}
