//! What a handler receives and what it answers with.
use crate::{Error, Result, accounts::SessionLifetime, ensure, validate as v};
use axum::{
    Json,
    body::Bytes,
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
    pub trace: crate::observability::RequestTrace,
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
    pub(super) fn session_token(&self, development: bool) -> &str {
        let prefix = if development {
            "dispatch_session="
        } else {
            "__Host-dispatch_session="
        };
        let mut values = self
            .headers
            .get_all("cookie")
            .iter()
            .filter_map(|header| header.to_str().ok())
            .flat_map(|header| header.split(';'))
            .map(str::trim)
            .filter_map(|part| part.strip_prefix(prefix));
        let first = values.next().unwrap_or("");
        if values.next().is_some() { "" } else { first }
    }
}

enum Payload {
    Value(Value),
    Encoded(Bytes),
}

pub struct Reply {
    value: Payload,
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
        Ok(Self {
            value: Payload::Encoded(Bytes::from(serde_json::to_vec(value)?)),
            status,
            cookie: None,
        })
    }
    pub fn ok() -> Self {
        Self::json(json!({"ok":true}))
    }
    pub fn status(value: Value, status: u16) -> Self {
        Self {
            value: Payload::Value(value),
            status,
            cookie: None,
        }
    }
    /// JSON already serialized by a trusted response producer, never raw request input.
    pub(super) fn encoded(value: Bytes) -> Self {
        Self {
            value: Payload::Encoded(value),
            status: 200,
            cookie: None,
        }
    }
    /// `{"ok":true}` that also starts the browser's session.
    pub fn signed_in(raw: &str, development: bool, lifetime: SessionLifetime) -> Self {
        let secure = if development { "" } else { "; Secure" };
        let name = if development {
            "dispatch_session"
        } else {
            "__Host-dispatch_session"
        };
        Self::ok().cookie(format!(
            "{name}={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}",
            lifetime.seconds()
        ))
    }
    /// `{"ok":true}` that also ends the browser's session.
    pub fn signed_out(development: bool) -> Self {
        let (name, secure) = if development {
            ("dispatch_session", "")
        } else {
            ("__Host-dispatch_session", "; Secure")
        };
        Self::ok().cookie(format!(
            "{name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}"
        ))
    }
    fn cookie(mut self, cookie: String) -> Self {
        self.cookie = Some(cookie);
        self
    }
}
impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap();
        let mut response = match self.value {
            Payload::Value(value) => (status, Json(value)).into_response(),
            Payload::Encoded(value) => (
                status,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                value,
            )
                .into_response(),
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn encoded_replies_preserve_json_status_and_cookies() {
        let value = json!({"rows":[{"name":"Álvaro","hours":8.5}]});
        let reply = Reply::of_status(&value, 201)
            .unwrap()
            .cookie("test=value".into())
            .into_response();
        assert_eq!(reply.status(), 201);
        assert_eq!(reply.headers()["content-type"], "application/json");
        assert_eq!(reply.headers()["set-cookie"], "test=value");
        let body = axum::body::to_bytes(reply.into_body(), 1024).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), value);
    }
}
