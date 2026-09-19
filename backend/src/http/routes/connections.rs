//! Provider connections. Signing in drives a real browser, so these handlers
//! wait outside the database and check the member's permission again after
//! every wait, before anything is written or answered.
use crate::{
    Error, Result, State,
    accounts::Context,
    browsers::Provider,
    db::{Store, s},
    ensure,
    http::{
        input::{Input, Reply, optional},
        route::{Dsp, Grant, Member, Route, async_get, async_post, read},
    },
    validate as v,
};
use serde_json::{Value, json};
use std::sync::Arc;

const MANAGE: Dsp = Dsp("connections.manage");
// Failures a member can recover from in the same browser session.
pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/connections", MANAGE, connection),
        async_get(
            "/api/dsp/connections/{provider}",
            MANAGE,
            provider_connection,
        ),
        async_post("/api/dsp/connections/{provider}", MANAGE, save),
        async_post("/api/dsp/connections/{provider}/save", MANAGE, save),
        async_post("/api/dsp/connections/{provider}/check", MANAGE, check),
        async_post("/api/dsp/connections/{provider}/disable", MANAGE, disable),
        async_post("/api/dsp/connections/{provider}/verify", MANAGE, verify),
        async_get(
            "/api/dsp/connections/{provider}/screenshot",
            MANAGE,
            screenshot,
        ),
        async_post("/api/dsp/connections/{provider}/assist", MANAGE, assist),
        async_post("/api/dsp/connections/{provider}/submit", MANAGE, submit),
    ]
}

/// The Paycom connection, with the browser session a member can take over when there is one.
pub fn summary(db: &Store, c: &Member) -> Result<Value> {
    let mut value = db.connection(c.dsp_id())?;
    if let Some(session) = c.state.browsers.get(c.dsp_id())
        && session.interactive()
    {
        value["verificationSessionId"] = json!(session.id);
    }
    Ok(value)
}

fn connection(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Ok(Reply::json(summary(db, c)?))
}

// Every flow starts the same way: who is asking, and about which provider. An
// unknown provider answers `not_found`, but only to someone allowed to ask.
async fn open(state: &Arc<State>, input: &Input, access: Dsp) -> Result<(Context, Provider)> {
    let auth = input.clone();
    let c = state.run(move |db| access.authorize(db, &auth)).await?;
    Ok((c, Provider::parse(input.param("provider"))?))
}

async fn revalidate(state: &Arc<State>, c: &Context, access: Dsp) -> Result<()> {
    let context = c.clone();
    state
        .run(move |db| access.revalidate(db, &context).map(|_| ()))
        .await
}

// Every flow ends the same way too: the connection as it now stands, for a
// member who may still see it.
async fn answer(state: &Arc<State>, c: &Context, provider: Provider, access: Dsp) -> Result<Reply> {
    revalidate(state, c, access).await?;
    let connection = state.connection(s(&c.dsp, "id"), provider).await?;
    Ok(Reply::json(connection))
}

// Cancels the provider's jobs, then closes its browser, before credentials change.
async fn stop(state: &Arc<State>, c: &Context, provider: Provider, access: Dsp) -> Result<()> {
    let context = c.clone();
    state
        .run(move |db| {
            access.revalidate(db, &context)?;
            db.cancel_provider(s(&context.dsp, "id"), provider)
        })
        .await?;
    state.browsers.revoke_for(s(&c.dsp, "id"), provider).await;
    Ok(())
}

async fn provider_connection(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    let (c, provider) = open(&state, &input, access).await?;
    let connection = state.connection(s(&c.dsp, "id"), provider).await?;
    Ok(Reply::json(connection))
}

async fn save(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    let (c, provider) = open(&state, &input, access).await?;
    let id = s(&c.dsp, "id");
    let _operation = state.browsers.operation(id)?;
    provider.validate_credentials(&input.body)?;
    stop(&state, &c, provider, access).await?;
    let (context, credentials) = (c.clone(), input.body);
    state
        .run(move |db| db.save_credentials(&context, &credentials, provider))
        .await?;
    state.ensure_provider_browser(id, true, provider).await?;
    answer(&state, &c, provider, access).await
}

async fn check(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    let (c, provider) = open(&state, &input, access).await?;
    let id = s(&c.dsp, "id");
    let _operation = state.browsers.operation(id)?;
    v::fields(&input.body, &[])?;
    state.ensure_provider_browser(id, true, provider).await?;
    answer(&state, &c, provider, access).await
}

async fn disable(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    let (c, provider) = open(&state, &input, access).await?;
    let _operation = state.browsers.operation(s(&c.dsp, "id"))?;
    v::fields(&input.body, &["removeCredentials"])?;
    let remove = optional(&input.body, "removeCredentials", v::boolean)?.unwrap_or(false);
    stop(&state, &c, provider, access).await?;
    let context = c.clone();
    state
        .run(move |db| db.disable(&context, remove, provider))
        .await?;
    answer(&state, &c, provider, access).await
}

// What a member does inside a browser session that is waiting for them.
#[derive(Clone, Copy, PartialEq)]
enum Step {
    Verify,
    Screenshot,
    Assist,
    Submit,
}

async fn verify(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    step(state, input, access, Step::Verify).await
}
async fn screenshot(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    step(state, input, access, Step::Screenshot).await
}
async fn assist(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    step(state, input, access, Step::Assist).await
}
async fn submit(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    step(state, input, access, Step::Submit).await
}

async fn step(state: Arc<State>, input: Input, access: Dsp, step: Step) -> Result<Reply> {
    let (c, provider) = open(&state, &input, access).await?;
    let b = &input.body;
    let expired = || Error::new("verification_expired", 409);
    let session = state
        .browsers
        .get_for(s(&c.dsp, "id"), provider)
        .ok_or_else(expired)?;
    if step != Step::Verify {
        let sent = if step == Step::Screenshot {
            &input.query
        } else {
            b
        };
        let allowed: &[&str] = if step == Step::Assist {
            &["sessionId", "input"]
        } else {
            &["sessionId"]
        };
        v::fields(sent, allowed)?;
        let current = v::text(sent, "sessionId", 36, 36)? == session.id;
        ensure(current, "verification_expired", 409)?;
    }
    let (command, types, timeout) = match step {
        Step::Verify => {
            v::fields(b, &["code"])?;
            (
                json!({"action":"verify","code":v::text(b, "code", 1, 128)?}),
                vec!["ready", "challenge"],
                180,
            )
        }
        Step::Screenshot => {
            ensure(session.interactive(), "verification_expired", 409)?;
            (json!({"action":"screenshot"}), vec!["screenshot"], 10)
        }
        Step::Assist => {
            ensure(session.interactive(), "verification_expired", 409)?;
            validate_browser_input(&b["input"])?;
            (
                json!({"action":"assist","input":b["input"]}),
                vec!["assisted"],
                15,
            )
        }
        Step::Submit => {
            if session.ready() {
                return answer(&state, &c, provider, access).await;
            }
            (
                json!({"action":"complete_assistance"}),
                vec!["ready", "challenge"],
                180,
            )
        }
    };
    let result = session
        .request_guarded(command, &types, timeout, Some((&state, &c)))
        .await;
    if [Step::Verify, Step::Submit].contains(&step) {
        state.browser_result(&session, &result).await?;
    }
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            if !error.is_any(crate::Code::RECOVERABLE) {
                state.browsers.revoke_current(&session).await;
            }
            return Err(error);
        }
    };
    revalidate(&state, &c, access).await?;
    if step == Step::Screenshot {
        let shot = json!({"image":value["image"],"sessionId":session.id});
        return Ok(Reply::json(shot));
    }
    if step == Step::Assist {
        return Ok(Reply::ok());
    }
    ensure(
        step != Step::Submit || session.ready(),
        "verification_incomplete",
        409,
    )?;
    let context = c.clone();
    state
        .run(move |db| {
            db.audit(
                Some(s(&context.auth.user, "id")),
                Some(s(&context.dsp, "id")),
                "connection.verification_submitted",
                provider.id(),
            )
        })
        .await?;
    answer(&state, &c, provider, access).await
}

fn validate_browser_input(input: &Value) -> Result<()> {
    let kind = v::choice(
        input,
        "kind",
        &["click", "pointer", "scroll", "type", "key"],
    )?;
    match kind {
        "type" => {
            v::fields(input, &["kind", "text"])?;
            v::text(input, "text", 1, 256)?;
        }
        "key" => {
            v::fields(input, &["kind", "key", "shift"])?;
            v::choice(
                input,
                "key",
                &[
                    "Enter",
                    "Tab",
                    "Backspace",
                    "Delete",
                    "Escape",
                    "ArrowDown",
                    "ArrowUp",
                    "ArrowLeft",
                    "ArrowRight",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                ],
            )?;
            if input.get("shift").is_some() {
                v::boolean(input, "shift")?;
            }
        }
        _ => {
            v::fields(
                input,
                match kind {
                    "pointer" => &["kind", "phase", "x", "y", "pressed"],
                    "scroll" => &["kind", "x", "y", "deltaX", "deltaY"],
                    _ => &["kind", "x", "y"],
                },
            )?;
            for (key, min, max) in [("x", 0., 1600.), ("y", 0., 1100.)] {
                ensure(
                    input[key]
                        .as_f64()
                        .is_some_and(|n| (min..=max).contains(&n)),
                    "invalid_input",
                    400,
                )?;
            }
            if kind == "pointer" {
                v::choice(input, "phase", &["down", "move", "up"])?;
                v::boolean(input, "pressed")?;
            }
            if kind == "scroll" {
                for key in ["deltaX", "deltaY"] {
                    ensure(
                        input[key]
                            .as_f64()
                            .is_some_and(|n| (-2000.0..=2000.0).contains(&n)),
                        "invalid_input",
                        400,
                    )?;
                }
            }
        }
    }
    Ok(())
}
