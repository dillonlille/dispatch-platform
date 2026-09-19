//! The answer to a path or method no route was registered for.
use super::{
    input::Input,
    middleware,
    route::{Dsp, Grant, PlatformOwner},
    routes::team::TEAM,
};
use crate::{Error, Result, State, db::Store};
use axum::{
    extract::{Request, State as AxumState},
    http::Method,
    response::Response,
};
use std::sync::Arc;

/// Always `not_found`, but the platform and DSP areas first ask for what their
/// routes ask for, so probing them tells a caller nothing they may not know.
pub async fn unmatched(AxumState(state): AxumState<Arc<State>>, request: Request) -> Response {
    match refuse(state, request).await {
        Ok(never) => match never {},
        Err(error) => middleware::failure(error),
    }
}
async fn refuse(state: Arc<State>, request: Request) -> Result<std::convert::Infallible> {
    let input = middleware::input(&state, request, "").await?;
    let reading = input.method == Method::GET && !input.path.starts_with("/api/invitations/");
    let work = move |db: &Store| {
        if input.path.starts_with("/api/platform/") {
            PlatformOwner.authorize(db, &input)?;
        } else if input.path.starts_with("/api/dsp/") {
            Dsp(area_permission(&input)).authorize(db, &input)?;
        }
        Err(Error::new("not_found", 404))
    };
    if reading {
        state.read(work).await
    } else {
        state.run(work).await
    }
}
// What each part of the DSP area asked for before routes carried their own
// access. New routes never come here; this only keeps old answers the same.
fn area_permission(input: &Input) -> &'static str {
    let mut parts = input.path.split('/').skip(3);
    let (endpoint, detail) = (parts.next().unwrap_or(""), parts.next());
    match (endpoint, detail, input.method == Method::POST) {
        ("connections", ..) => "connections.manage",
        ("members", Some("invite"), true) | ("invitations", ..) => "members.invite",
        ("members", _, true) => "members.manage",
        ("roles", _, true) => "roles.manage",
        ("members" | "roles", _, false) => TEAM,
        ("audit", ..) => "audit.view",
        ("profile", _, true) => "settings.manage",
        ("paycom", _, true) | ("schedules", ..) => "timecard.manage",
        ("jobs", Some("meal-breaks"), false) => "timecard.view",
        ("jobs", ..) | ("cortex", _, true) => "collections.run",
        _ => "timecard.view",
    }
}
