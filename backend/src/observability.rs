//! Structured events contain only selected operational fields, never raw requests.
use serde_json::{Value, json};

#[derive(Default)]
pub struct RequestContext {
    pub actor: Option<String>,
    pub tenant: Option<String>,
    pub account: Option<String>,
    pub route: Option<&'static str>,
    pub bulk: bool,
}
pub type RequestTrace = std::sync::Arc<std::sync::Mutex<RequestContext>>;

pub fn event(level: &str, event: &str, fields: Value) {
    eprintln!(
        "{}",
        json!({"at":super::db::iso(),"level":level,"event":event,"fields":fields})
    );
}

pub fn route(path: &str) -> &'static str {
    match path {
        "/api/health" => "/api/health",
        "/api/auth/login" => "/api/auth/login",
        "/api/auth/logout" => "/api/auth/logout",
        "/api/auth/password" => "/api/auth/password",
        "/api/auth/forgot-password" => "/api/auth/forgot-password",
        "/api/auth/reset-password" => "/api/auth/reset-password",
        "/api/session" => "/api/session",
        "/api/session/dsp" => "/api/session/dsp",
        "/api/dsp/jobs" => "/api/dsp/jobs",
        "/api/dsp/paycom/meal-breaks" => "/api/dsp/paycom/meal-breaks",
        "/api/dsp/paycom/settings" => "/api/dsp/paycom/settings",
        "/api/dsp/timecards" => "/api/dsp/timecards",
        "/api/dsp/employees" => "/api/dsp/employees",
        "/api/dsp/collection-updates" => "/api/dsp/collection-updates",
        "/api/platform/health" => "/api/platform/health",
        _ if path.starts_with("/api/invitations/") => "/api/invitations/:token/*",
        _ if path.starts_with("/api/dsp/employees/") => "/api/dsp/employees/:code",
        _ if path.starts_with("/api/dsp/") => "/api/dsp/*",
        _ if path.starts_with("/api/platform/") => "/api/platform/*",
        "/" => "/",
        _ if path.starts_with("/assets/") => "/assets/*",
        _ => "/unmatched",
    }
}
