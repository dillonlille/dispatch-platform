//! What the dashboard polls: readiness, its own updates, collection progress and presence.
use crate::{
    Error, Result, State, crypto,
    http::{
        assets::browser_update_ready,
        input::{Input, Reply},
        route::{Dsp, Grant, Route, async_get, async_post, probe},
    },
    roles, validate as v,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

// Collection progress refreshes both the timecard pages and the collections page.
const LIVE_UPDATES: &str = "timecard.view|collections.run";

pub fn routes() -> Vec<Route> {
    vec![
        probe("/api/health", health),
        probe("/api/browser-update", browser_update),
        async_get(
            "/api/dsp/collection-updates",
            Dsp(LIVE_UPDATES),
            collection_updates,
        ),
        async_post("/api/dsp/presence", Dsp(roles::ACCESS), presence),
    ]
}

fn health(state: &State) -> Reply {
    Reply::json(json!({
        "status":"ready",
        "environment":state.config.environment,
        "release":state.config.release,
        "runtime":"rust"
    }))
}

fn browser_update(state: &State) -> Reply {
    let ready = browser_update_ready(&state.config);
    Reply::json(json!({"build":crypto::sha(state.config.release.as_bytes()),"ready":ready}))
}

// Long polling carries the same signed-view header as every other read.
// No DB slot or transaction stays open while a client waits.
async fn collection_updates(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    v::fields(&input.query, &["after"])?;
    let after = v::text(&input.query, "after", 0, 100)?.to_owned();
    let auth = input.clone();
    let dsp = state
        .read(move |db| Ok(access.authorize(db, &auth)?.dsp.id))
        .await?;
    let _slot = state
        .updates
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new("platform_busy", 503))?;
    let mut updates = state.updates.subscribe(&dsp);
    if state.updates.token(&updates) == after {
        let _ = tokio::time::timeout(Duration::from_secs(20), updates.changed()).await;
    }
    let revision = state.updates.token(&updates);
    let changes = state.updates.changes(&dsp, &after, &revision);
    // Permission changes and expired sessions take effect during an open wait.
    state
        .read(move |db| access.authorize(db, &input).map(|_| ()))
        .await?;
    Reply::of(&crate::contracts::CollectionUpdates { revision, changes })
}

// Heartbeats only touch memory, so they stay off the platform write lock.
async fn presence(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    v::fields(&input.body, &["tab", "state"])?;
    let tab = v::text(&input.body, "tab", 1, 64)?.to_owned();
    let active = match v::choice(&input.body, "state", &["active", "idle", "gone"])? {
        "gone" => None,
        state => Some(state == "active"),
    };
    let member = state
        .read(move |db| {
            let c = access.authorize(db, &input)?;
            // A platform owner looking into a DSP is never shown to its team.
            Ok((!c.auth.user.platform_owner).then(|| {
                (
                    c.dsp.id.as_str().to_owned(),
                    c.auth.user.id.as_str().to_owned(),
                )
            }))
        })
        .await?;
    if let Some((dsp, user)) = member {
        state.presence.beat(&dsp, &user, &tab, active);
    }
    Ok(Reply::ok())
}
