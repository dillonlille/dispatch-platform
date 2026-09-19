//! What a handler receives and what it answers with.
use crate::{Error, Result, ensure, validate as v};
use axum::{
    Json,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Input {
    pub path: String,
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Value,
    pub query: Value,
    pub ip: String,
    // The registered pattern, whose `{name}` segments name the path parameters.
    pub(super) pattern: &'static str,
}
impl Input {
    pub fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
    /// The path segment registered as `{name}`, exactly as the client sent it:
    /// never percent-decoded, and empty when the client sent an empty segment.
    pub fn param(&self, name: &str) -> &str {
        self.pattern
            .split('/')
            .zip(self.path.split('/'))
            .find(|(pattern, _)| {
                pattern
                    .strip_prefix('{')
                    .and_then(|p| p.strip_suffix('}'))
                    .is_some_and(|p| p == name)
            })
            .map_or("", |(_, segment)| segment)
    }
    pub(super) fn session_token(&self) -> &str {
        self.header("cookie")
            .split(';')
            .map(str::trim)
            .find_map(|part| part.strip_prefix("dispatch_session="))
            .unwrap_or("")
    }
}

pub struct Reply {
    value: Value,
    status: u16,
    cookie: Option<String>,
}
impl Reply {
    pub fn json(value: Value) -> Self {
        Self::status(value, 200)
    }
    /// A typed response: the struct the route answers with, as the dashboard's contract has it.
    pub fn of<T: serde::Serialize>(value: &T) -> Result<Self> {
        Self::of_status(value, 200)
    }
    pub fn of_status<T: serde::Serialize>(value: &T, status: u16) -> Result<Self> {
        Ok(Self::status(serde_json::to_value(value)?, status))
    }
    pub fn ok() -> Self {
        Self::json(json!({"ok":true}))
    }
    pub fn status(value: Value, status: u16) -> Self {
        Self {
            value,
            status,
            cookie: None,
        }
    }
    /// `{"ok":true}` that also starts the browser's session.
    pub fn signed_in(raw: &str, development: bool) -> Self {
        let secure = if development { "" } else { "; Secure" };
        Self::ok().cookie(format!(
            "dispatch_session={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{secure}"
        ))
    }
    /// `{"ok":true}` that also ends the browser's session.
    pub fn signed_out() -> Self {
        Self::ok().cookie("dispatch_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0".into())
    }
    fn cookie(mut self, cookie: String) -> Self {
        self.cookie = Some(cookie);
        self
    }
}
impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        let mut response =
            (StatusCode::from_u16(self.status).unwrap(), Json(self.value)).into_response();
        if let Some(cookie) = self.cookie
            && let Ok(value) = cookie.parse()
        {
            response.headers_mut().insert("set-cookie", value);
        }
        response
    }
}

/// Reads a field only when it is present: `optional(b, "visible", v::boolean)?`.
pub fn optional<'a, T>(
    value: &'a Value,
    key: &str,
    read: impl FnOnce(&'a Value, &str) -> Result<T>,
) -> Result<Option<T>> {
    value.get(key).map(|_| read(value, key)).transpose()
}
pub fn optional_text<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    Ok(optional(value, key, |q, key| v::text(q, key, 0, max))?.unwrap_or(""))
}
/// `direction=desc` in a query; ascending when absent.
pub fn descending(q: &Value) -> Result<bool> {
    let direction = optional(q, "direction", |q, key| v::choice(q, key, &["asc", "desc"]))?;
    Ok(direction == Some("desc"))
}
pub fn query_number(q: &Value, key: &str, default: usize, min: usize, max: usize) -> Result<usize> {
    let n = if let Some(v) = q.get(key) {
        v.as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| Error::new("invalid_input", 400))?
    } else {
        default
    };
    ensure((min..=max).contains(&n), "invalid_input", 400)?;
    Ok(n)
}
