//! Signing in and out, and changing or recovering a password.
use crate::{
    Result, State,
    contracts::{LoginRequest, PasswordRequest, ResetRequest},
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Anyone, Grant, Public, Route, Session, User, async_post, write},
    },
    validate as v,
};
use std::sync::Arc;

pub fn routes() -> Vec<Route> {
    vec![
        async_post("/api/auth/login", Public, login),
        write("/api/auth/logout", Session, logout),
        async_post("/api/auth/password", Session, change_password),
        write("/api/auth/forgot-password", Public, forgot_password),
        async_post("/api/auth/reset-password", Public, reset_password),
    ]
}

async fn login(state: Arc<State>, input: Input, _: Public) -> Result<Reply> {
    let login = LoginRequest::parse(&input.body)?;
    let raw = state.login(login.email, login.password, input.ip).await?;
    Ok(Reply::signed_in(&raw, state.config.development))
}

fn logout(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    db.platform
        .exec("DELETE FROM sessions WHERE hash=?", [&user.hash])?;
    Ok(Reply::signed_out())
}

// Hashing a password waits outside the database, so the session is read first.
async fn change_password(state: Arc<State>, input: Input, access: Session) -> Result<Reply> {
    let request = PasswordRequest::parse(&input.body)?;
    let auth = state.read(move |db| access.authorize(db, &input)).await?;
    state
        .change_password(auth, request.current_password, request.password)
        .await?;
    Ok(Reply::signed_out())
}

fn forgot_password(db: &Store, _: &Anyone, input: &Input) -> Result<Reply> {
    let b = &input.body;
    v::fields(b, &["email"])?;
    let email = v::email(b, "email")?;
    db.throttle(&format!("forgot:ip:{}", input.ip), 20, 3600000)?;
    db.throttle(&format!("forgot:email:{email}"), 5, 3600000)?;
    db.recovery(&email)?;
    Ok(Reply::status(serde_json::json!({"ok":true}), 202))
}

async fn reset_password(state: Arc<State>, input: Input, _: Public) -> Result<Reply> {
    let request = ResetRequest::parse(&input.body)?;
    let key = format!("reset:{}", input.ip);
    state.run(move |db| db.throttle(&key, 30, 3600000)).await?;
    state
        .reset_password(request.token, request.password)
        .await?;
    Ok(Reply::ok())
}
