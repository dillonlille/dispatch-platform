use crate::{
    Error, Result, State,
    contracts::UniformInput,
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Dsp, Grant, Member, Route, async_get, read, write},
    },
    roles, validate as v,
};
use std::{sync::Arc, time::Duration};

const MANAGE: Dsp = Dsp("uniforms.manage");
pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/uniforms", Dsp(roles::ACCESS), inventory),
        async_get("/api/dsp/uniforms/updates", Dsp(roles::ACCESS), updates),
        read("/api/dsp/uniforms/history", Dsp(roles::ACCESS), history),
        write("/api/dsp/uniforms/initialize", MANAGE, initialize),
        write("/api/dsp/uniforms", MANAGE, create),
        write("/api/dsp/uniforms/{id}", MANAGE, update),
        write("/api/dsp/uniforms/{id}/archive", MANAGE, archive),
        write(
            "/api/dsp/uniforms/stock/{id}",
            Dsp("uniforms.adjust"),
            adjust,
        ),
    ]
}
fn inventory(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Reply::of(&db.uniform_inventory(c.dsp_id())?)
}
fn initialize(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["starter"])?;
    let result = db.initialize_uniforms(c, v::boolean(&input.body, "starter")?)?;
    c.state.uniform_updates.notify(c.dsp_id());
    Reply::of(&result)
}
fn create(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    save(db, c, input, None)
}
fn update(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    save(db, c, input, Some(input.param("id")))
}
fn save(db: &Store, c: &Member, input: &Input, id: Option<&str>) -> Result<Reply> {
    let result = db.save_uniform(c, id, &UniformInput::parse(&input.body)?)?;
    c.state.uniform_updates.notify(c.dsp_id());
    Reply::of_status(&result, if id.is_some() { 200 } else { 201 })
}
fn archive(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["revision"])?;
    let result = db.archive_uniform(
        c,
        input.param("id"),
        v::integer(&input.body, "revision", 0, i64::MAX)?,
    )?;
    c.state.uniform_updates.notify(c.dsp_id());
    Reply::of(&result)
}
fn adjust(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["delta", "requestId"])?;
    let result = db.adjust_uniform(
        c,
        input.param("id"),
        v::integer(&input.body, "delta", -1, 1)? as i32,
        v::text(&input.body, "requestId", 16, 100)?,
    )?;
    c.state.uniform_updates.notify(c.dsp_id());
    Reply::of(&result)
}
fn cursor(input: &Input, name: &str, default: i64) -> Result<i64> {
    v::fields(&input.query, &[name])?;
    input.query.get(name).map_or(Ok(default), |value| {
        value
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|n| *n >= 0)
            .ok_or_else(|| Error::new("invalid_input", 400))
    })
}
fn history(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    Reply::of(&db.uniform_history(c.dsp_id(), cursor(input, "before", i64::MAX)?)?)
}
async fn updates(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    let after = cursor(&input, "after", -1)?;
    let auth = input.clone();
    let dsp = state
        .read(move |db| Ok(access.authorize(db, &auth)?.dsp.id))
        .await?;
    let _slot = state
        .uniform_updates
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new("platform_busy", 503))?;
    // Subscribe before reading: a commit between the read and wait cannot be missed.
    let mut listener = state.uniform_updates.subscribe(&dsp);
    let auth = input.clone();
    let initial = state
        .read(move |db| {
            let c = access.authorize(db, &auth)?;
            db.uniform_updates(&c.dsp.id, after)
        })
        .await?;
    if initial.revision != after {
        return Reply::of(&initial);
    }
    let _ = tokio::time::timeout(Duration::from_secs(20), listener.changed()).await;
    // No DB connection is held during the wait, and every response rechecks access.
    let result = state
        .read(move |db| {
            let c = access.authorize(db, &input)?;
            db.uniform_updates(&c.dsp.id, after)
        })
        .await?;
    Reply::of(&result)
}
