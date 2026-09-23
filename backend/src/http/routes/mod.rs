//! One file per area of the API. Each lists its routes next to their handlers.
use super::route::Route;

pub mod audit;
pub mod auth;
pub mod connections;
pub mod jobs;
pub mod live;
pub mod platform;
pub mod schedules;
pub mod security;
pub mod session;
pub mod settings;
pub mod team;
pub mod timecard;
pub mod uniforms;

pub fn all() -> Vec<Route> {
    [
        live::routes(),
        auth::routes(),
        security::routes(),
        session::routes(),
        platform::routes(),
        team::routes(),
        timecard::routes(),
        schedules::routes(),
        jobs::routes(),
        connections::routes(),
        audit::routes(),
        settings::routes(),
        uniforms::routes(),
    ]
    .into_iter()
    .flatten()
    .collect()
}
