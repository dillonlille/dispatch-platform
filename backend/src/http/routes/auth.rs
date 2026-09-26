//! Signing in and out, and changing or recovering a password.
use crate::{
    Result, State,
    accounts::SessionLifetime,
    contracts::{LoginRequest, PasswordRequest, ResetRequest},
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Grant, Public, Route, Session, User, async_post, write},
    },
    validate as v,
};
use std::sync::Arc;

pub fn routes() -> Vec<Route> {
    vec![
        async_post("/api/auth/login", Public, login),
        write("/api/auth/logout", Session, logout),
        async_post("/api/auth/password", Session, change_password),
        async_post("/api/auth/forgot-password", Public, forgot_password),
        async_post("/api/auth/reset-password", Public, reset_password),
    ]
}

async fn login(state: Arc<State>, input: Input, _: Public) -> Result<Reply> {
    let login = LoginRequest::parse(&input.body)?;
    let lifetime = if login.remember_me {
        SessionLifetime::Remembered
    } else {
        SessionLifetime::Standard
    };
    let user_agent = input.header("user-agent").to_owned();
    let raw = state
        .login(login.email, login.password, input.ip, user_agent, lifetime)
        .await?;
    Ok(Reply::signed_in(&raw, state.config.development, lifetime))
}

fn logout(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    db.platform
        .exec("DELETE FROM sessions WHERE hash=?", [&user.hash])?;
    Ok(Reply::signed_out(user.state.config.development))
}

// Hashing a password waits outside the database, so the session is read first.
async fn change_password(state: Arc<State>, input: Input, access: Session) -> Result<Reply> {
    let request = PasswordRequest::parse(&input.body)?;
    let ip = input.ip.clone();
    let auth = state.read(move |db| access.authorize(db, &input)).await?;
    state
        .change_password(auth, request.current_password, request.password, ip)
        .await?;
    Ok(Reply::signed_out(state.config.development))
}

async fn forgot_password(state: Arc<State>, input: Input, _: Public) -> Result<Reply> {
    let started = std::time::Instant::now();
    let jitter = u16::from_le_bytes(crate::crypto::random::<2>()?) % 50;
    let result = async {
        let b = &input.body;
        v::fields(b, &["email"])?;
        let email = v::email(b, "email")?.to_owned();
        let ip = input.ip;
        state
            .run(move |db| {
                db.throttle_ip("forgot-ip", &ip, 20, 3600000)?;
                db.throttle(&format!("forgot:email:{email}"), 5, 3600000)?;
                if let Err(error) = db.recovery(&email) {
                    // Account-specific queue state must not change the public response. Operators
                    // still receive the sanitized failure through the structured event stream.
                    crate::observability::event(
                        "error",
                        "account.recovery_failed",
                        serde_json::json!({"error":error.code}),
                    );
                }
                Ok(())
            })
            .await?;
        Ok(Reply::status(serde_json::json!({"ok":true}), 202))
    }
    .await;
    let floor = std::time::Duration::from_millis(300 + u64::from(jitter));
    if let Some(remaining) = floor.checked_sub(started.elapsed()) {
        tokio::time::sleep(remaining).await;
    }
    result
}

async fn reset_password(state: Arc<State>, input: Input, _: Public) -> Result<Reply> {
    let request = ResetRequest::parse(&input.body)?;
    let ip = input.ip;
    state
        .run(move |db| db.throttle_ip("reset-ip", &ip, 30, 3600000))
        .await?;
    state
        .reset_password(request.token, request.password)
        .await?;
    Ok(Reply::ok())
}
