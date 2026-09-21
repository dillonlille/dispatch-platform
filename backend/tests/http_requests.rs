//! Requests against the real router, served in-process over a loopback socket.
//! The expectations were recorded before the route table existed, so they pin
//! how the HTTP layer answers rather than how it is built.
use dispatch_backend::{
    State,
    config::Config,
    crypto,
    db::{self, Store, s},
    operations,
};
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    sync::{Arc, atomic::Ordering},
};

const SCRIPT: &str = "/assets/app-abcd1234.js";

struct Server {
    _root: tempfile::TempDir,
    origin: String,
    state: Arc<State>,
    client: reqwest::Client,
}
struct Who {
    cookie: String,
    csrf: String,
    view: Option<String>,
}
struct Answer {
    status: u16,
    body: Value,
    headers: reqwest::header::HeaderMap,
}
impl Answer {
    fn error(&self) -> &str {
        self.body["error"].as_str().unwrap_or("")
    }
    fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
}
struct Call<'a> {
    method: &'a str,
    path: &'a str,
    who: Option<&'a Who>,
    body: Option<String>,
    headers: Vec<(&'a str, String)>,
    csrf: bool,
    origin: bool,
}
impl<'a> Call<'a> {
    fn new(method: &'a str, path: &'a str) -> Self {
        Self {
            method,
            path,
            who: None,
            body: None,
            headers: vec![],
            csrf: true,
            origin: true,
        }
    }
    fn get(path: &'a str) -> Self {
        Self::new("GET", path)
    }
    fn post(path: &'a str, body: Value) -> Self {
        Self::new("POST", path).raw(body.to_string())
    }
    fn raw(mut self, body: String) -> Self {
        self.body = Some(body);
        self
    }
    fn who(mut self, who: &'a Who) -> Self {
        self.who = Some(who);
        self
    }
    fn header(mut self, name: &'a str, value: &str) -> Self {
        self.headers.push((name, value.to_owned()));
        self
    }
    fn without_csrf(mut self) -> Self {
        self.csrf = false;
        self
    }
    fn without_origin(mut self) -> Self {
        self.origin = false;
        self
    }
}
impl Server {
    async fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let dashboard = root.path().join("dashboard");
        std::fs::create_dir_all(dashboard.join("assets")).unwrap();
        std::fs::write(dashboard.join("index.html"), "<html><head></head></html>").unwrap();
        std::fs::write(dashboard.join(&SCRIPT[1..]), "console.log(1)").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut config = Config::load().unwrap();
        config.root = root.path().join("state");
        db::private_dir(&config.root).unwrap();
        config.development = true;
        config.fixture = true;
        config.environment = "preview".into();
        config.standalone = true;
        config.dashboard = dashboard;
        config.port = port;
        config.origin = format!("http://127.0.0.1:{port}");
        operations::seed(&Store::initialize(config.clone()).unwrap()).unwrap();
        let state = State::new(config).unwrap();
        let app = dispatch_backend::http::router(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            _root: root,
            origin: format!("http://127.0.0.1:{port}"),
            state,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }
    // A session row written directly, so tests do not pay for password hashing.
    async fn session(&self, email: &'static str) -> Who {
        let raw = crypto::token().unwrap();
        let token = raw.clone();
        self.state
            .run(move |db| {
                let user = db
                    .platform
                    .one("SELECT id,version FROM users WHERE email=?", [email])?
                    .unwrap();
                db.platform.exec(
                    "INSERT INTO sessions VALUES (?,?,?,?,?)",
                    rusqlite::params![
                        crypto::sha(&token),
                        s(&user, "id"),
                        db::n(&user, "version"),
                        db::now() + 600000,
                        db::now()
                    ],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let mut who = Who {
            cookie: format!("dispatch_session={raw}"),
            csrf: String::new(),
            view: None,
        };
        let session = self.send(Call::get("/api/session").who(&who)).await;
        assert_eq!(session.status, 200, "{}", session.body);
        who.csrf = s(&session.body, "csrf").to_owned();
        who
    }
    async fn dsp(&self, name: &'static str) -> String {
        self.state
            .read(move |db| {
                let row = db
                    .platform
                    .one("SELECT id FROM dsps WHERE name=?", [name])?;
                Ok(s(&row.unwrap(), "id").to_owned())
            })
            .await
            .unwrap()
    }
    async fn member(&self, email: &'static str) -> Who {
        let mut who = self.session(email).await;
        let dsp = self.dsp("Northline Logistics").await;
        let view = self
            .send(Call::post("/api/session/dsp", json!({"dspId":dsp})).who(&who))
            .await;
        assert_eq!(view.status, 200, "{}", view.body);
        who.view = Some(s(&view.body, "token").to_owned());
        who
    }
    async fn send(&self, call: Call<'_>) -> Answer {
        let method = reqwest::Method::from_bytes(call.method.as_bytes()).unwrap();
        let mut headers = reqwest::header::HeaderMap::new();
        let mut set = |name: &str, value: &str| {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap();
            headers.insert(name, value.parse().unwrap());
        };
        if call.origin {
            set("origin", &self.origin);
        }
        if let Some(who) = call.who {
            set("cookie", &who.cookie);
            if call.csrf {
                set("x-csrf-token", &who.csrf);
            }
            if let Some(view) = &who.view {
                set("x-dispatch-view", view);
            }
        }
        if call.body.is_some() {
            set("content-type", "application/json");
        }
        for (name, value) in &call.headers {
            set(name, value);
        }
        let mut request = self
            .client
            .request(method, format!("{}{}", self.origin, call.path))
            .headers(headers);
        if let Some(body) = call.body {
            request = request.body(body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let bytes = response.bytes().await.unwrap();
        Answer {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            headers,
        }
    }
    async fn expect(&self, call: Call<'_>, status: u16, error: &str) {
        let label = format!("{} {}", call.method, call.path);
        let answer = self.send(call).await;
        assert_eq!(
            (answer.status, answer.error()),
            (status, error),
            "{label}: {}",
            answer.body
        );
        if !error.is_empty() && answer.body != Value::Null {
            assert_eq!(
                answer.body,
                json!({"error":error,"message":error.replace('_', " ")}),
                "{label}"
            );
        }
    }
}

#[tokio::test]
async fn unmatched_paths_and_methods_answer_as_they_always_have() {
    let server = Server::start().await;
    let owner = server.session("owner@dispatch.test").await;
    let member = server.member("member@dispatch.test").await;
    // Outside the DSP and platform areas nothing is authenticated before the 404.
    server
        .expect(Call::get("/api/nope"), 404, "not_found")
        .await;
    server.expect(Call::get("/nope"), 404, "not_found").await;
    server
        .expect(Call::get("/api/invitations"), 404, "not_found")
        .await;
    let call = Call::post("/api/invitations/some-token", json!({}));
    server.expect(call, 404, "not_found").await;
    // A known path with the wrong method is unmatched, never 405.
    server
        .expect(Call::post("/api/health", json!({})), 404, "not_found")
        .await;
    server
        .expect(Call::post("/api/session", json!({})), 404, "not_found")
        .await;
    server
        .expect(Call::get("/api/auth/login"), 404, "not_found")
        .await;
    server
        .expect(Call::new("HEAD", "/api/health"), 404, "")
        .await;
    let wrong = server.send(Call::post("/api/session", json!({}))).await;
    assert_eq!((wrong.status, wrong.header("allow")), (404, ""));
    let call = Call::new("PUT", "/api/session").raw("{}".into());
    server.expect(call, 404, "not_found").await;
    let call = Call::new("DELETE", "/api/session").raw("{}".into());
    server
        .expect(call.without_origin(), 403, "invalid_origin")
        .await;
    server
        .expect(Call::new("OPTIONS", "/api/session"), 404, "not_found")
        .await;
    // The DSP and platform areas authenticate before admitting a path is unknown.
    server
        .expect(Call::get("/api/dsp/nope"), 401, "sign_in_required")
        .await;
    server
        .expect(Call::get("/api/platform/nope"), 401, "sign_in_required")
        .await;
    let call = Call::get("/api/platform/nope").who(&member);
    server.expect(call, 403, "platform_owner_required").await;
    server
        .expect(
            Call::get("/api/platform/nope").who(&owner),
            404,
            "not_found",
        )
        .await;
    server
        .expect(
            Call::get("/api/dsp/nope").who(&owner),
            403,
            "dsp_view_required",
        )
        .await;
    server
        .expect(Call::get("/api/dsp/nope").who(&member), 404, "not_found")
        .await;
    let call = Call::post("/api/dsp/employees", json!({})).who(&member);
    server.expect(call, 404, "not_found").await;
    server
        .expect(Call::get("/api/dsp/profile").who(&member), 404, "not_found")
        .await;
    // An unknown path still asks for the permission its area asked for.
    let call = Call::post("/api/dsp/members", json!({})).who(&member);
    server.expect(call, 403, "permission_denied").await;
    let call = Call::get("/api/dsp/connections/paycom/check").who(&member);
    server.expect(call, 403, "permission_denied").await;
    let call = Call::get("/api/dsp/audit/nope").who(&member);
    server.expect(call, 404, "not_found").await;
    let call = Call::post("/api/dsp/nope", json!({}))
        .who(&member)
        .without_csrf();
    server.expect(call, 403, "csrf_required").await;
    // Path segments are taken as sent: never decoded, and an empty one still
    // reaches the handler that validates it.
    let call = Call::get("/api/dsp/employees/").who(&member);
    server.expect(call, 400, "invalid_employee_code").await;
    let call = Call::get("/api/dsp/employees/E%30%301").who(&member);
    server.expect(call, 400, "invalid_employee_code").await;
    let call = Call::get("/api/dsp/employees/E001/").who(&member);
    server.expect(call, 404, "not_found").await;
    server
        .expect(Call::get("/api/invitations/"), 404, "invitation_expired")
        .await;
    let call = Call::get("/api/dsp/connections/unknown").who(&member);
    server.expect(call, 403, "permission_denied").await;
}

#[tokio::test]
async fn the_request_pipeline_checks_host_origin_content_type_and_size() {
    let server = Server::start().await;
    let call = Call::get("/api/health").header("host", "evil.example");
    server.expect(call, 400, "invalid_host").await;
    let call = Call::post("/api/auth/login", json!({})).without_origin();
    server.expect(call, 403, "invalid_origin").await;
    let call = Call::post("/api/auth/login", json!({})).header("origin", "http://evil.example");
    server.expect(call, 403, "invalid_origin").await;
    let call = Call::post("/api/auth/login", json!({})).header("content-type", "text/plain");
    server.expect(call, 415, "json_required").await;
    let call = Call::new("POST", "/api/auth/login").raw("{".into());
    server.expect(call, 400, "invalid_input").await;
    // Malformed requests are refused before the path is looked at.
    let call = Call::new("POST", "/api/nope").raw("{".into());
    server.expect(call, 400, "invalid_input").await;
    server
        .expect(Call::get("/api/nope?a=1&a=2"), 400, "invalid_input")
        .await;
    let call = Call::new("POST", "/api/nope").raw(format!("\"{}\"", "x".repeat(70 * 1024)));
    server.expect(call, 413, "request_too_large").await;
    // Health answers before the query is parsed.
    let health = server.send(Call::get("/api/health?a=1&a=2")).await;
    assert_eq!(health.status, 200);
    assert_eq!(
        health.body,
        json!({
            "status":"ready",
            "environment":"preview",
            "release":server.state.config.release,
            "runtime":"rust"
        })
    );
    for answer in [health, server.send(Call::get("/api/nope")).await] {
        assert!(answer.header("x-request-id").starts_with("req_"));
        assert_eq!(answer.header("x-content-type-options"), "nosniff");
        assert_eq!(answer.header("referrer-policy"), "same-origin");
        assert_eq!(answer.header("x-frame-options"), "DENY");
        assert_eq!(answer.header("cache-control"), "no-store");
        assert_eq!(
            answer.header("content-security-policy"),
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' \
             'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: ws:; font-src 'self'; \
             object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        );
    }
    let update = server.send(Call::get("/api/browser-update")).await;
    assert_eq!(update.status, 200);
    assert_eq!(update.header("cache-control"), "no-store");
    assert_eq!(
        update.body["build"],
        crypto::sha(server.state.config.release.as_bytes())
    );
}

#[tokio::test]
async fn every_access_kind_refuses_and_admits_the_right_callers() {
    let server = Server::start().await;
    let owner = server.session("owner@dispatch.test").await;
    let member = server.member("member@dispatch.test").await;
    // Public.
    server
        .expect(
            Call::get("/api/invitations/unknown"),
            404,
            "invitation_expired",
        )
        .await;
    let call = Call::post(
        "/api/auth/forgot-password",
        json!({"email":"nobody@dispatch.test"}),
    );
    let answer = server.send(call).await;
    assert_eq!((answer.status, &answer.body), (202, &json!({"ok":true})));
    // Session.
    server
        .expect(Call::get("/api/session"), 401, "sign_in_required")
        .await;
    let call = Call::post("/api/auth/logout", json!({}))
        .who(&member)
        .without_csrf();
    server.expect(call, 403, "csrf_required").await;
    let session = server.send(Call::get("/api/session").who(&member)).await;
    assert_eq!(session.status, 200);
    assert_eq!(session.body["user"]["email"], "member@dispatch.test");
    // Platform owner.
    server
        .expect(Call::get("/api/platform/dsps"), 401, "sign_in_required")
        .await;
    let call = Call::get("/api/platform/dsps").who(&member);
    server.expect(call, 403, "platform_owner_required").await;
    let call = Call::post("/api/platform/dsps/x/status", json!({})).who(&member);
    server.expect(call, 403, "platform_owner_required").await;
    let dsps = server
        .send(Call::get("/api/platform/dsps").who(&owner))
        .await;
    assert_eq!(dsps.status, 200);
    assert_eq!(dsps.body.as_array().unwrap().len(), 3);
    // DSP permission.
    server
        .expect(Call::get("/api/dsp/employees"), 401, "sign_in_required")
        .await;
    server
        .expect(
            Call::get("/api/dsp/employees").who(&owner),
            403,
            "dsp_view_required",
        )
        .await;
    for path in [
        "/api/dsp/jobs",
        "/api/dsp/schedules",
        "/api/dsp/connections",
        "/api/dsp/connections/paycom",
        "/api/dsp/members",
        "/api/dsp/invitations",
    ] {
        server
            .expect(Call::get(path).who(&member), 403, "permission_denied")
            .await;
    }
    for (path, body) in [
        ("/api/dsp/jobs", json!({})),
        ("/api/dsp/jobs/meal-breaks", json!({})),
        ("/api/dsp/jobs/job_x/cancel", json!({})),
        ("/api/dsp/profile", json!({})),
        ("/api/dsp/schedules/preview", json!({})),
        ("/api/dsp/paycom/settings", json!({})),
        ("/api/dsp/roles", json!({})),
        ("/api/dsp/members/invite", json!({})),
        ("/api/dsp/members/mem_x", json!({})),
        ("/api/dsp/connections/paycom/check", json!({})),
        ("/api/dsp/cortex/meal-breaks/collect", json!({})),
    ] {
        server
            .expect(
                Call::post(path, body).who(&member),
                403,
                "permission_denied",
            )
            .await;
    }
    let employees = server
        .send(Call::get("/api/dsp/employees?limit=2").who(&member))
        .await;
    assert_eq!(employees.status, 200, "{}", employees.body);
    assert_eq!(employees.body["employees"].as_array().unwrap().len(), 2);
    let code = s(&employees.body["employees"][0], "code").to_owned();
    let employee = server
        .send(Call::get(&format!("/api/dsp/employees/{code}")).who(&member))
        .await;
    assert_eq!(employee.status, 200, "{}", employee.body);
    let call = Call::post("/api/dsp/presence", json!({"tab":"t1","state":"active"})).who(&member);
    let presence = server.send(call).await;
    assert_eq!(
        (presence.status, &presence.body),
        (200, &json!({"ok":true}))
    );
    // Input is validated before the session on the routes that always did so.
    let call = Call::post("/api/dsp/presence", json!({}));
    server.expect(call, 400, "invalid_input").await;
    server
        .expect(
            Call::get("/api/dsp/collection-updates?x=1"),
            400,
            "invalid_input",
        )
        .await;
    let call = Call::post("/api/auth/password", json!({}));
    server.expect(call, 400, "invalid_input").await;
}

#[tokio::test]
async fn only_dsp_and_schedule_writes_that_succeed_wake_the_scheduler() {
    let server = Server::start().await;
    let owner = server.member("owner@dispatch.test").await;
    let revision = || server.state.schedule_revision.load(Ordering::Acquire);
    let before = revision();
    let call = Call::post("/api/dsp/profile", json!({})).who(&owner);
    server.expect(call, 400, "invalid_input").await;
    let call = Call::post("/api/dsp/schedules/preview", json!({})).who(&owner);
    assert_ne!(server.send(call).await.status, 404);
    assert_eq!(revision(), before);
    let profile = json!({
        "name":"Northline Logistics",
        "timezone":"America/Chicago",
        "abbreviation":"NL",
        "stationCode":"DCH1"
    });
    let saved = server
        .send(Call::post("/api/dsp/profile", profile).who(&owner))
        .await;
    assert_eq!((saved.status, &saved.body), (200, &json!({"ok":true})));
    assert_eq!(revision(), before + 1);
    let created = server
        .send(Call::post("/api/platform/dsps", json!({"name":"Fourth DSP"})).who(&owner))
        .await;
    assert_eq!(created.status, 201, "{}", created.body);
    assert_eq!(revision(), before + 2);
    let id = s(&created.body["dsp"], "id").to_owned();
    let path = format!("/api/platform/dsps/{id}/retry");
    let call = Call::post(&path, json!({})).who(&owner);
    server.expect(call, 409, "dsp_already_initialized").await;
    assert_eq!(revision(), before + 2);
    // Suspending a DSP has never woken the scheduler.
    let path = format!("/api/platform/dsps/{id}/status");
    let suspended = server
        .send(Call::post(&path, json!({"status":"suspended"})).who(&owner))
        .await;
    assert_eq!(suspended.status, 200, "{}", suspended.body);
    assert_eq!(suspended.body["status"], "suspended");
    assert_eq!(revision(), before + 2);
}

#[tokio::test]
async fn signing_in_and_out_sets_and_clears_the_session_cookie() {
    let server = Server::start().await;
    let credentials = json!({"email":"member@dispatch.test","password":"Dispatch-demo-2026!"});
    let login = server
        .send(Call::post("/api/auth/login", credentials))
        .await;
    assert_eq!((login.status, &login.body), (200, &json!({"ok":true})));
    let cookie = login.header("set-cookie").to_owned();
    let (pair, attributes) = cookie.split_once(';').unwrap();
    assert_eq!(
        attributes,
        " Path=/; HttpOnly; SameSite=Strict; Max-Age=28800"
    );
    let mut who = Who {
        cookie: pair.to_owned(),
        csrf: String::new(),
        view: None,
    };
    let session = server.send(Call::get("/api/session").who(&who)).await;
    who.csrf = s(&session.body, "csrf").to_owned();
    let logout = server
        .send(Call::post("/api/auth/logout", json!({})).who(&who))
        .await;
    assert_eq!((logout.status, &logout.body), (200, &json!({"ok":true})));
    assert_eq!(
        logout.header("set-cookie"),
        "dispatch_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    );
    server
        .expect(Call::get("/api/session").who(&who), 401, "sign_in_required")
        .await;
}

#[tokio::test]
async fn remembered_sessions_have_a_fixed_three_day_deadline() {
    let server = Server::start().await;
    for value in [json!("true"), json!(1), Value::Null] {
        server.expect(Call::post("/api/auth/login", json!({
            "email":"member@dispatch.test", "password":"Dispatch-demo-2026!", "rememberMe":value
        })), 400, "invalid_input").await;
    }
    for (remember, seconds) in [(false, 28800), (true, 259200)] {
        let login = server.send(Call::post("/api/auth/login", json!({
            "email":"member@dispatch.test", "password":"Dispatch-demo-2026!", "rememberMe":remember
        }))).await;
        assert_eq!(login.status, 200, "{}", login.body);
        let (pair, attributes) = login.header("set-cookie").split_once(';').unwrap();
        assert_eq!(
            attributes,
            format!(" Path=/; HttpOnly; SameSite=Strict; Max-Age={seconds}")
        );
        let hash = crypto::sha(pair.strip_prefix("dispatch_session=").unwrap());
        let query_hash = hash.clone();
        let (expiry, created): (i64, i64) = server
            .state
            .read(move |db| {
                Ok(db
                    .platform
                    .one_as(
                        "SELECT expires_at,created_at FROM sessions WHERE hash=?",
                        [&query_hash],
                    )?
                    .unwrap())
            })
            .await
            .unwrap();
        assert_eq!(expiry - created, seconds * 1000);
        let who = Who {
            cookie: pair.to_owned(),
            csrf: String::new(),
            view: None,
        };
        for _ in 0..2 {
            let session = server.send(Call::get("/api/session").who(&who)).await;
            assert_eq!(session.status, 200);
            assert!(
                session.header("set-cookie").is_empty(),
                "activity must not renew the cookie"
            );
        }
        let query_hash = hash.clone();
        let (unchanged,): (i64,) = server
            .state
            .read(move |db| {
                Ok(db
                    .platform
                    .one_as(
                        "SELECT expires_at FROM sessions WHERE hash=?",
                        [&query_hash],
                    )?
                    .unwrap())
            })
            .await
            .unwrap();
        assert_eq!(
            unchanged, expiry,
            "activity must not slide the server deadline"
        );
        server
            .state
            .run(move |db| {
                db.platform.exec(
                    "UPDATE sessions SET expires_at=? WHERE hash=?",
                    rusqlite::params![db::now(), hash],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        server
            .expect(Call::get("/api/session").who(&who), 401, "sign_in_required")
            .await;
    }
}

#[tokio::test]
async fn the_dashboard_is_served_with_validators_and_everything_else_is_not_found() {
    let server = Server::start().await;
    let index = server.send(Call::get("/")).await;
    assert_eq!(index.status, 200);
    assert_eq!(index.header("content-type"), "text/html; charset=utf-8");
    assert_eq!(index.header("cache-control"), "no-store");
    let script = server.send(Call::get(SCRIPT)).await;
    assert_eq!(script.status, 200);
    assert_eq!(
        script.header("content-type"),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        script.header("cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(script.header("content-length"), "14");
    let etag = script.header("etag").to_owned();
    let cached = server
        .send(Call::get(SCRIPT).header("if-none-match", &etag))
        .await;
    assert_eq!(cached.status, 304);
    assert_eq!(cached.header("etag"), etag);
    let head = server.send(Call::new("HEAD", SCRIPT)).await;
    assert_eq!((head.status, head.header("content-length")), (200, "14"));
    // Assets answer before the query is parsed; nothing else does.
    assert_eq!(server.send(Call::get("/?a=1&a=2")).await.status, 200);
    server
        .expect(Call::get("/assets/missing.js"), 404, "not_found")
        .await;
    server.expect(Call::get("/assets/"), 404, "not_found").await;
    server
        .expect(Call::get("/assets/..%2Findex.html"), 404, "not_found")
        .await;
    server
        .expect(Call::post(SCRIPT, json!({})), 404, "not_found")
        .await;
    server
        .expect(Call::get("/index.html"), 404, "not_found")
        .await;
}
