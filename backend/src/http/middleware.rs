//! What every request passes through before and after its route: the request
//! log, the security headers, the Host and Origin checks, and the parsing of a
//! request into an [`Input`].
use super::input::Input;
use crate::{Error, Result, State, crypto, ensure, observability};
use axum::{
    body::to_bytes,
    extract::{ConnectInfo, Request, State as AxumState},
    http::{HeaderName, Method, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc, time::Duration};

const BODY_LIMIT: usize = 64 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(15);

// The error code of a failed request, carried to the request log.
#[derive(Clone)]
struct Failure(String);

pub fn failure(error: Error) -> Response {
    let code = Failure(error.code.clone());
    let mut response = error.into_response();
    response.extensions_mut().insert(code);
    response
}

pub async fn pipeline(
    AxumState(state): AxumState<Arc<State>>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = std::time::Instant::now();
    let route = observability::route(request.uri().path());
    let method = request.method().clone();
    let trace = observability::RequestTrace::default();
    request.extensions_mut().insert(trace.clone());
    let client = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .and_then(|peer| {
            state
                .config
                .trusted_proxy
                .client_ip(peer.0.ip(), request.headers())
                .ok()
        })
        .map(|ip| {
            crypto::sign(
                &state.key,
                &format!("client:{}:{ip}", crate::db::now() / 86400000),
            )
        });
    let request_id = match crypto::id("req") {
        Ok(id) => id,
        Err(error) => return error.into_response(),
    };
    let mut response = match admit(&state, &request) {
        Ok(()) => next.run(request).await,
        Err(error) => failure(error),
    };
    let status = response.status().as_u16();
    let level = match status {
        500.. => "error",
        400.. => "warn",
        _ => "info",
    };
    let error = response.extensions().get::<Failure>().map(|f| f.0.clone());
    let context = trace.lock().unwrap_or_else(|poison| poison.into_inner());
    observability::event(
        level,
        "http.request",
        json!({
            "requestId":request_id,
            "method":method.as_str(),
            "route":context.route.unwrap_or(route),
            "actorId":context.actor,
            "dspId":context.tenant,
            "account":context.account,
            "client":client,
            "bulk":context.bulk,
            "status":status,
            "elapsedMs":started.elapsed().as_millis(),
            "error":error
        }),
    );
    let headers = response.headers_mut();
    headers.insert("x-request-id", request_id.parse().unwrap());
    if state.config.origin.starts_with("https://") {
        headers.insert(
            "strict-transport-security",
            "max-age=31536000".parse().unwrap(),
        );
    }
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "same-origin"),
        ("x-frame-options", "DENY"),
    ] {
        headers.insert(HeaderName::from_static(name), value.parse().unwrap());
    }
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert("no-store".parse().unwrap());
    let development = state.config.development;
    let csp = format!(
        "default-src 'self'; script-src 'self'{}; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; connect-src 'self' blob:{}; font-src 'self'; object-src 'none'; \
         base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        if development { " 'unsafe-inline'" } else { "" },
        if development { " ws:" } else { "" }
    );
    headers.insert("content-security-policy", csp.parse().unwrap());
    response
}

// Only the configured origin, or this machine, may address the server, and
// only the dashboard's own pages may send the API anything but a read.
fn admit(state: &State, request: &Request) -> Result<()> {
    let header = |name| request.headers().get(name).and_then(|v| v.to_str().ok());
    let host = header(header::HOST).unwrap_or("");
    let origin =
        url::Url::parse(&state.config.origin).map_err(|_| Error::new("invalid_origin", 500))?;
    let authority = &origin[url::Position::BeforeHost..url::Position::AfterPort];
    ensure(
        host == authority || host == format!("127.0.0.1:{}", state.config.port),
        "invalid_host",
        400,
    )?;
    let reads = [Method::GET, Method::HEAD, Method::OPTIONS];
    if request.uri().path().starts_with("/api/") && !reads.contains(request.method()) {
        let origin = header(header::ORIGIN);
        ensure(origin == Some(&state.config.origin), "invalid_origin", 403)?;
        let kind = header(header::CONTENT_TYPE).and_then(|v| v.split(';').next());
        ensure(kind == Some("application/json"), "json_required", 415)?;
    }
    Ok(())
}

/// Parses a request the way every route and the unmatched answer expect it:
/// only GET and POST exist, a query names each key once, and a body is JSON
/// of at most 64 KiB that arrives within 15 seconds.
pub async fn input(state: &State, request: Request, pattern: &'static str) -> Result<Input> {
    let (parts, body) = request.into_parts();
    let known = [Method::GET, Method::POST].contains(&parts.method);
    ensure(known, "not_found", 404)?;
    let mut query = serde_json::Map::new();
    for (k, value) in url::form_urlencoded::parse(parts.uri.query().unwrap_or("").as_bytes()) {
        ensure(!query.contains_key(k.as_ref()), "invalid_input", 400)?;
        query.insert(k.into_owned(), json!(value));
    }
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|v| v.0.ip())
        .ok_or_else(|| Error::new("client_address_unavailable", 500))?;
    let ip = state.config.trusted_proxy.client_ip(peer, &parts.headers)?;
    let body = tokio::time::timeout(BODY_TIMEOUT, to_bytes(body, BODY_LIMIT))
        .await
        .map_err(|_| Error::new("request_timeout", 408))?
        .map_err(|_| Error::new("request_too_large", 413))?;
    let body = if parts.method == Method::POST {
        serde_json::from_slice(&body)?
    } else {
        Value::Null
    };
    let trace = parts
        .extensions
        .get::<observability::RequestTrace>()
        .cloned()
        .unwrap_or_default();
    {
        let mut context = trace.lock().unwrap_or_else(|poison| poison.into_inner());
        context.route = Some(pattern);
        context.bulk =
            query.get("limit").is_some_and(|value| value == "all") || pattern.ends_with("/export");
        if ["/api/auth/login", "/api/auth/forgot-password"].contains(&pattern) {
            context.account = body
                .get("email")
                .and_then(Value::as_str)
                .filter(|email| email.len() <= 254)
                .map(|email| {
                    crypto::sign(
                        &state.key,
                        &format!("account:{}", email.trim().to_lowercase()),
                    )
                });
        }
    }
    Ok(Input {
        path: parts.uri.path().to_owned(),
        method: parts.method,
        headers: parts.headers,
        body,
        query: Value::Object(query),
        ip,
        trace,
        pattern,
    })
}
