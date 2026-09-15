use super::{
    Error, Result, State,
    accounts::{Auth, Context},
    browsers, crypto,
    db::{Store, flag, iso, s},
    ensure, validate as v, workforce,
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
#[derive(Clone)]
struct Input {
    path: String,
    method: String,
    headers: HeaderMap,
    body: Value,
    query: Value,
    ip: String,
}
impl Input {
    fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
    fn raw(&self) -> &str {
        self.header("cookie")
            .split(';')
            .map(str::trim)
            .find_map(|part| part.strip_prefix("dispatch_session="))
            .unwrap_or("")
    }
    fn auth(&self, db: &Store) -> Result<Auth> {
        let a = db.authenticate(self.raw())?;
        if self.method == "POST" {
            ensure(
                crypto::equal(&a.csrf, self.header("x-csrf-token")),
                "csrf_required",
                403,
            )?;
        }
        Ok(a)
    }
    fn context(&self, db: &Store, permission: &str) -> Result<Context> {
        db.from_view(&self.auth(db)?, self.header("x-dispatch-view"), permission)
    }
    fn owner(&self, db: &Store) -> Result<Auth> {
        let a = self.auth(db)?;
        ensure(
            flag(&a.user, "platformOwner"),
            "platform_owner_required",
            403,
        )?;
        Ok(a)
    }
}
struct Reply {
    value: Value,
    status: u16,
    cookie: Option<String>,
}
impl Reply {
    fn json(value: Value) -> Self {
        Self {
            value,
            status: 200,
            cookie: None,
        }
    }
    fn ok() -> Self {
        Self::json(json!({"ok":true}))
    }
    fn status(value: Value, status: u16) -> Self {
        Self {
            value,
            status,
            cookie: None,
        }
    }
    fn cookie(value: Value, cookie: String) -> Self {
        Self {
            value,
            status: 200,
            cookie: Some(cookie),
        }
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
pub fn router(state: Arc<State>) -> Router {
    Router::new().fallback(dispatch).with_state(state)
}
async fn dispatch(AxumState(state): AxumState<Arc<State>>, request: Request) -> Response {
    let development = state.config.development;
    let result = process(state, request).await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    let headers = response.headers_mut();
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "same-origin"),
        ("x-frame-options", "DENY"),
        ("cache-control", "no-store"),
    ] {
        headers.insert(
            axum::http::HeaderName::from_static(name),
            value.parse().unwrap(),
        );
    }
    let csp = format!(
        "default-src 'self'; script-src 'self'{}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'{}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        if development { " 'unsafe-inline'" } else { "" },
        if development { " ws:" } else { "" }
    );
    headers.insert("content-security-policy", csp.parse().unwrap());
    response
}
async fn process(state: Arc<State>, request: Request) -> Result<Response> {
    let host = request
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let origin =
        url::Url::parse(&state.config.origin).map_err(|_| Error::new("invalid_origin", 500))?;
    let authority = origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
    ensure(
        host == authority || host == format!("127.0.0.1:{}", state.config.port),
        "invalid_host",
        400,
    )?;
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    if path.starts_with("/api/") && !["GET", "HEAD", "OPTIONS"].contains(&method.as_str()) {
        ensure(
            headers.get("origin").and_then(|v| v.to_str().ok()) == Some(&state.config.origin),
            "invalid_origin",
            403,
        )?;
        ensure(
            headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                == Some("application/json"),
            "json_required",
            415,
        )?;
    }
    if method == "GET" && path == "/api/health" {
        return Ok(Json(json!({"status":"ready","environment":state.config.environment,"release":state.config.release,"runtime":"rust"})).into_response());
    }
    if (method == "GET" || method == "HEAD") && (path == "/" || path.starts_with("/assets/")) {
        ensure(
            !path.contains("..") && !path.contains('%') && !path.contains('\\'),
            "not_found",
            404,
        )?;
        let file = state.config.dashboard.join(if path == "/" {
            "index.html"
        } else {
            path.trim_start_matches('/')
        });
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|_| Error::new("not_found", 404))?;
        let mime = match file.extension().and_then(|s| s.to_str()).unwrap_or("") {
            "html" => "text/html; charset=utf-8",
            "js" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
        let mut reply = Response::new(if method == "HEAD" {
            Body::empty()
        } else {
            Body::from(bytes)
        });
        reply
            .headers_mut()
            .insert("content-type", mime.parse().unwrap());
        return Ok(reply);
    }
    ensure(["GET", "POST"].contains(&method.as_str()), "not_found", 404)?;
    let mut query = serde_json::Map::new();
    for (k, value) in url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()) {
        ensure(!query.contains_key(k.as_ref()), "invalid_input", 400)?;
        query.insert(k.into_owned(), json!(value));
    }
    let ip = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|v| v.0.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".into());
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        to_bytes(request.into_body(), 64 * 1024),
    )
    .await
    .map_err(|_| Error::new("request_timeout", 408))?
    .map_err(|_| Error::new("request_too_large", 413))?;
    let body = if method == "POST" {
        serde_json::from_slice(&body)?
    } else {
        Value::Null
    };
    let input = Input {
        path,
        method,
        headers,
        body,
        query: Value::Object(query),
        ip,
    };
    if input.method == "POST" && input.path == "/api/auth/login" {
        v::fields(&input.body, &["email", "password"])?;
        let email = v::email(&input.body, "email")?;
        let password = v::text(&input.body, "password", 0, 128)?.to_owned();
        let raw = state.login(email, password, input.ip.clone()).await?;
        return Ok(Reply::cookie(
            json!({"ok":true}),
            format!(
                "dispatch_session={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{}",
                if state.config.development {
                    ""
                } else {
                    "; Secure"
                }
            ),
        )
        .into_response());
    }
    if let Some(reply) = asynchronous(&state, &input).await? {
        return Ok(reply.into_response());
    }
    let pool = state.clone();
    let reply = if input.method == "GET" && !input.path.starts_with("/api/invitations/") {
        state.read(move |db| synchronous(db, &input, &pool)).await?
    } else {
        state.run(move |db| synchronous(db, &input, &pool)).await?
    };
    Ok(reply.into_response())
}
fn synchronous(db: &Store, i: &Input, state: &State) -> Result<Reply> {
    let b = &i.body;
    let path = i.path.as_str();
    let write = i.method == "POST";
    match (i.method.as_str(), path) {
        ("POST", "/api/auth/forgot-password") => {
            v::fields(b, &["email"])?;
            let email = v::email(b, "email")?;
            db.throttle(&format!("forgot:ip:{}", i.ip), 20, 3600000)?;
            db.throttle(&format!("forgot:email:{email}"), 5, 3600000)?;
            db.recovery(&email)?;
            return Ok(Reply::status(json!({"ok":true}), 202));
        }
        ("POST", "/api/auth/reset-password") => {
            v::fields(b, &["token", "password"])?;
            db.throttle(&format!("reset:{}", i.ip), 30, 3600000)?;
            db.reset_password(
                v::text(b, "token", 43, 43)?,
                v::text(b, "password", 12, 128)?,
            )?;
            return Ok(Reply::ok());
        }
        ("POST", "/api/auth/logout") => {
            let a = i.auth(db)?;
            db.platform
                .exec("DELETE FROM sessions WHERE hash=?", [a.hash])?;
            return Ok(Reply::cookie(
                json!({"ok":true}),
                "dispatch_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0".into(),
            ));
        }
        ("POST", "/api/auth/password") => {
            let a = i.auth(db)?;
            v::fields(b, &["currentPassword", "password"])?;
            db.change_password(
                &a,
                v::text(b, "currentPassword", 0, 128)?,
                v::text(b, "password", 12, 128)?,
            )?;
            return Ok(Reply::cookie(
                json!({"ok":true}),
                "dispatch_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0".into(),
            ));
        }
        ("GET", "/api/session") => {
            let a = i.auth(db)?;
            return Ok(Reply::json(
                json!({"user":a.user,"csrf":a.csrf,"dsps":db.dsps(&a)?,"development":db.config.development,"environment":db.config.environment,"release":db.config.release,"separatePreview":false,"standalone":true,"providerMode":if db.config.fixture{"fixture"}else{"native"}}),
            ));
        }
        ("POST", "/api/session/dsp") => {
            let a = i.auth(db)?;
            v::fields(b, &["dspId"])?;
            let c = db.context(&a, v::text(b, "dspId", 1, 100)?, "read")?;
            db.audit(
                Some(s(&a.user, "id")),
                Some(s(&c.dsp, "id")),
                if flag(&a.user, "platformOwner") {
                    "dsp.owner_view_opened"
                } else {
                    "dsp.view_opened"
                },
                "",
            )?;
            return Ok(Reply::json(
                json!({"dsp":c.dsp,"role":c.role,"token":db.view_token(&c),"profile":db.profile(s(&c.dsp,"id"))?}),
            ));
        }
        _ => {}
    }
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if parts.get(1) == Some(&"invitations") {
        let raw = *parts.get(2).ok_or_else(|| Error::new("not_found", 404))?;
        if !write && parts.len() == 3 {
            db.throttle(&format!("invite-read:{}", i.ip), 60, 60000)?;
            return Ok(Reply::json(db.invitation(raw)?));
        }
        if write && parts.len() == 4 && parts[3] == "accept" {
            db.throttle(&format!("invite:{}", i.ip), 20, 3600000)?;
            v::fields(b, &["firstName", "lastName", "password"])?;
            db.accept_invitation(
                raw,
                &v::name(b, "firstName", 100)?,
                &v::name(b, "lastName", 100)?,
                v::text(b, "password", 12, 128)?,
            )?;
            return Ok(Reply::ok());
        }
    }
    if path.starts_with("/api/platform/") {
        return platform(db, i, state, &parts);
    }
    if path.starts_with("/api/dsp/") {
        return tenant(db, i, state, &parts);
    }
    Err(Error::new("not_found", 404))
}
fn platform(db: &Store, i: &Input, state: &State, parts: &[&str]) -> Result<Reply> {
    let a = i.owner(db)?;
    let actor = s(&a.user, "id");
    let b = &i.body;
    let write = i.method == "POST";
    match (i.method.as_str(), i.path.as_str()) {
        ("GET", "/api/platform/dsps") => Ok(Reply::json(db.dsps(&a)?)),
        ("POST", "/api/platform/dsps") => {
            v::fields(b, &["name", "timezone", "ownerEmail"])?;
            ensure(
                b.get("name").is_some() || b.get("ownerEmail").is_some(),
                "invalid_input",
                400,
            )?;
            let name = if b.get("name").is_some() {
                v::name(b, "name", 100)?
            } else {
                "New DSP".into()
            };
            let tz = if b.get("timezone").is_some() {
                v::timezone(b, "timezone")?
            } else {
                "UTC".into()
            };
            let email = if b.get("ownerEmail").is_some() {
                Some(v::email(b, "ownerEmail")?)
            } else {
                None
            };
            let dsp = db.create_dsp(&name, &tz, actor, false)?;
            let id = s(&dsp, "id");
            if b.get("name").is_none() {
                db.set_profile(id, json!({"setupRequired":true}))?;
            }
            let mut out = json!({"dsp":dsp});
            if let Some(email) = email {
                let raw = db.invite(&a, id, &email, "owner")?;
                let url = format!("{}/#invite?token={raw}", db.config.origin);
                db.mail(
                    &email,
                    &format!("Join {name} on Dispatch"),
                    &format!("Open {url} to accept your invitation."),
                )?;
                out["invitationUrl"] = json!(url);
            }
            Ok(Reply::status(out, 201))
        }
        ("GET", "/api/platform/jobs") => Ok(Reply::json(db.list_jobs(None)?)),
        ("GET", "/api/platform/audit") => Ok(Reply::json(db.audits(None, 200)?)),
        ("GET", "/api/platform/health") => {
            let counts: HashMap<String, Value> = db
                .jobs
                .all("SELECT status,count(*) n FROM jobs GROUP BY status", [])?
                .into_iter()
                .map(|r| (s(&r, "status").into(), r["n"].clone()))
                .collect();
            Ok(Reply::json(
                json!({"environment":db.config.environment,"release":db.config.release,"jobs":counts,"browsers":{"active":state.browsers.active(),"capacity":db.config.browser_capacity},"dsps":db.platform.one("SELECT count(*) n FROM dsps",[])?.unwrap()["n"],"email":db.config.mail_available(),"providerMode":if db.config.fixture{"fixture"}else{"native"}}),
            ))
        }
        ("GET", "/api/platform/diagnostics") => Ok(Reply::json(diagnostics(db, state)?)),
        ("POST", "/api/platform/diagnostics") => {
            v::fields(b, &[])?;
            ensure(
                db.config.development || db.config.environment == "preview",
                "test_dsps_unavailable",
                409,
            )?;
            let dsp = db.create_dsp(
                &format!("Test DSP {}", iso()),
                "America/Chicago",
                actor,
                false,
            )?;
            let id = s(&dsp, "id");
            db.publish(id, &workforce::fixture("America/Chicago")?)?;
            db.audit(Some(actor), Some(id), "diagnostics.fixtures_loaded", "")?;
            Ok(Reply::json(diagnostics(db, state)?))
        }
        ("GET", "/api/platform/releases") => {
            let file = db.config.platform().join("dev-update.json");
            let update=std::fs::read(file).ok().and_then(|s|serde_json::from_slice::<Value>(&s).ok()).map(|v|json!({"status":v["status"],"commit":v["commit"],"updatedAt":v["updatedAt"]}));
            Ok(Reply::json(
                json!({"releases":[],"deploymentEnabled":false,"version":db.config.version,"standalone":true,"environment":db.config.environment,"release":db.config.release,"update":update}),
            ))
        }
        _ => {
            if write && parts.get(2) == Some(&"dsps") && parts.len() == 5 && parts[4] == "retry" {
                v::fields(b, &[])?;
                db.provision(parts[3])?;
                return Ok(Reply::json(db.get_dsp(parts[3])?));
            }
            if write && parts.get(2) == Some(&"releases") {
                return Err(Error::new("github_manages_updates", 409));
            }
            Err(Error::new("not_found", 404))
        }
    }
}
fn diagnostics(db: &Store, state: &State) -> Result<Value> {
    let memory = super::operations::memory();
    Ok(
        json!({"enabled":db.config.development||db.config.environment=="preview","storageAvailableBytes":super::operations::available_space(&db.config.root)?,"runtime":{"name":"Shared platform (Rust)","status":"Running","memoryBytes":memory.0+memory.1,"coreMemoryBytes":memory.0,"workerMemoryBytes":memory.1,"browsers":state.browsers.active()},"dsps":db.platform.all("SELECT d.id,d.name,d.status FROM dsps d WHERE EXISTS (SELECT 1 FROM audit a WHERE a.dsp_id=d.id AND a.action='diagnostics.fixtures_loaded') ORDER BY d.created_at DESC",[])?}),
    )
}
fn tenant(db: &Store, i: &Input, state: &State, parts: &[&str]) -> Result<Reply> {
    let write = i.method == "POST";
    let endpoint = *parts.get(2).unwrap_or(&"");
    let permission = match endpoint {
        "connections" => "connections",
        "members" | "invitations" => "members",
        "audit" | "settings" => "settings",
        "profile" if write => "settings",
        "paycom" | "schedule" if write => "settings",
        "jobs" if write => "collect",
        _ => "read",
    };
    let c = i.context(db, permission)?;
    let id = s(&c.dsp, "id");
    let actor = s(&c.auth.user, "id");
    let b = &i.body;
    let connection = || -> Result<Value> {
        let mut value = db.connection(id)?;
        if let Some(session) = state.browsers.get(id)
            && session.interactive()
        {
            value["verificationSessionId"] = json!(session.id);
        }
        Ok(value)
    };
    match (i.method.as_str(),i.path.as_str()) {
        ("GET","/api/dsp/overview")=>{let mut jobs=db.list_jobs(Some(id))?;jobs.as_array_mut().unwrap().truncate(8);Ok(Reply::json(json!({"dsp":c.dsp,"connection":connection()?,"schedule":db.schedule(id)?,"jobs":jobs,"workforce":db.employees(id,"",0,5,false)?,"audit":db.audits(Some(id),10)?})))},
        ("GET","/api/dsp/connections")=>Ok(Reply::json(connection()?)),
        ("GET","/api/dsp/jobs")=>Ok(Reply::json(db.list_jobs(Some(id))?)),
        ("POST","/api/dsp/jobs")=>{v::fields(b,&["requestId"])?;let job=db.enqueue(id,Some(actor),v::text(b,"requestId",1,128)?)?;db.audit(Some(actor),Some(id),"collection.requested","")?;Ok(Reply::status(job,202))},
        ("GET","/api/dsp/schedule")=>Ok(Reply::json(db.schedule(id)?)),
        ("POST","/api/dsp/schedule")=>{v::fields(b,&["enabled","localTime"])?;let result=db.set_schedule(id,v::boolean(b,"enabled")?,v::text(b,"localTime",5,5)?,s(&c.dsp,"timezone"))?;db.audit(Some(actor),Some(id),"schedule.updated","")?;Ok(Reply::json(result))},
        ("POST","/api/dsp/profile")=>{
            v::fields(b,&["name","timezone","abbreviation","stationCode"])?;let name=v::name(b,"name",100)?;let tz=v::timezone(b,"timezone")?;let abbreviation=v::text(b,"abbreviation",0,16)?.trim();let station=v::text(b,"stationCode",3,8)?;ensure(station.bytes().all(|b|b.is_ascii_alphanumeric()),"invalid_input",400)?;
            db.update_dsp(&c,&name,&tz)?;db.set_profile(id,json!({"abbreviation":abbreviation,"stationCode":station.to_uppercase(),"setupRequired":false}))?;db.audit(Some(actor),Some(id),"dsp.profile_completed","")?;Ok(Reply::ok())
        },
        ("GET","/api/dsp/paycom/settings")=>{let mut value=db.preferences(id)?;if !["owner","platform_owner"].contains(&c.role.as_str()){value["history"]=json!([]);}Ok(Reply::json(value))},
        ("POST","/api/dsp/paycom/settings")=>{v::fields(b,&["revision","values"])?;Ok(Reply::json(db.save_preferences(id,actor,v::integer(b,"revision",0,i64::MAX)?,&b["values"])?))},
        ("GET","/api/dsp/employees")=>{
            let q=&i.query;v::fields(q,&["q","direction","offset","limit"])?;let query=q.get("q").map(|_|v::text(q,"q",0,100)).transpose()?.unwrap_or("");let desc=direction(q)?;
            let offset=query_number(q,"offset",0,0,100000)?;let limit=query_number(q,"limit",50,1,100)?;Ok(Reply::json(db.employees(id,query,offset,limit,desc)?))
        },
        ("GET","/api/dsp/timecards")=>{let q=&i.query;v::fields(q,&["date","sort","direction"])?;let sort=q.get("sort").map(|_|v::choice(q,"sort",&["name","hours","inDay","outLunch","inLunch","outDay","totalHours","condition"])).transpose()?.unwrap_or("name");Ok(Reply::json(db.daily(id,v::text(q,"date",10,10)?,sort,direction(q)?)?))},
        ("GET","/api/dsp/members")=>Ok(Reply::json(db.members(id)?)),
        ("GET","/api/dsp/invitations")=>Ok(Reply::json(json!(db.platform.all("SELECT email,role,expires_at expiresAt,used_at IS NOT NULL accepted FROM invitations WHERE dsp_id=? ORDER BY expires_at DESC LIMIT 100",[id])?))),
        ("POST","/api/dsp/invitations/revoke")=>{v::fields(b,&["email"])?;let email=v::email(b,"email")?;db.platform.exec("DELETE FROM invitations WHERE dsp_id=? AND email=? COLLATE NOCASE AND used_at IS NULL",[id,&email])?;db.audit(Some(actor),Some(id),"invitation.revoked",&email)?;Ok(Reply::ok())},
        ("POST","/api/dsp/members/invite")=>{v::fields(b,&["email","role"])?;let email=v::email(b,"email")?;let role=v::choice(b,"role",&["owner","manager","member"])?;let raw=db.invite(&c.auth,id,&email,role)?;let url=format!("{}/#invite?token={raw}",db.config.origin);db.mail(&email,&format!("Join {} on Dispatch",s(&c.dsp,"name")),&format!("Open {url} to accept your invitation."))?;Ok(Reply::json(json!({"invitationUrl":url})))},
        ("GET","/api/dsp/audit")=>Ok(Reply::json(db.audits(Some(id),200)?)),
        ("POST","/api/dsp/settings")=>{v::fields(b,&["name","timezone"])?;Ok(Reply::json(db.update_dsp(&c,&v::name(b,"name",100)?,&v::timezone(b,"timezone")?)?))},
        _=>{
            if !write&&endpoint=="employees"&&parts.len()==4{return Ok(Reply::json(db.employee(id,parts[3])?));}
            if write&&endpoint=="members"&&parts.len()==4{v::fields(b,&["role"])?;let role=if b["role"].is_null(){None}else{Some(v::choice(b,"role",&["owner","manager","member"])?)};db.set_role(&c,parts[3],role)?;return Ok(Reply::ok());}
            Err(Error::new("not_found",404))
        }
    }
}
fn direction(q: &Value) -> Result<bool> {
    Ok(q.get("direction")
        .map(|_| v::choice(q, "direction", &["asc", "desc"]))
        .transpose()?
        .unwrap_or("asc")
        == "desc")
}
fn query_number(q: &Value, key: &str, default: usize, min: usize, max: usize) -> Result<usize> {
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
async fn asynchronous(state: &Arc<State>, i: &Input) -> Result<Option<Reply>> {
    let parts: Vec<_> = i.path.trim_start_matches('/').split('/').collect();
    let write = i.method == "POST";
    if write
        && parts.len() == 5
        && parts[1] == "platform"
        && parts[2] == "dsps"
        && ["status", "remove", "restore"].contains(&parts[4])
    {
        let id = parts[3].to_owned();
        let action = parts[4].to_owned();
        let input = i.clone();
        let tenant = id.clone();
        let result = state
            .run(move |db| {
                let a = input.owner(db)?;
                let b = &input.body;
                let actor = s(&a.user, "id");
                match action.as_str() {
                    "status" => {
                        v::fields(b, &["status"])?;
                        let status = v::choice(b, "status", &["active", "suspended"])?;
                        let dsp = db.set_status(&tenant, status, actor)?;
                        if status == "suspended" {
                            db.cancel_dsp(&tenant)?;
                        }
                        Ok(dsp)
                    }
                    "remove" => {
                        v::fields(b, &[])?;
                        db.set_status(&tenant, "suspended", actor)?;
                        db.set_profile(&tenant, json!({"removed":true}))?;
                        db.cancel_dsp(&tenant)?;
                        db.audit(Some(actor), Some(&tenant), "dsp.removed", "")?;
                        Ok(json!({"ok":true}))
                    }
                    _ => {
                        v::fields(b, &[])?;
                        let dsp = db.get_dsp(&tenant)?;
                        ensure(
                            !flag(&dsp, "permanent") && flag(&db.profile(&tenant)?, "removed"),
                            "dsp_not_removed",
                            409,
                        )?;
                        db.set_profile(&tenant, json!({"removed":false}))?;
                        let dsp = db.set_status(&tenant, "active", actor)?;
                        db.audit(Some(actor), Some(&tenant), "dsp.restored", "")?;
                        Ok(dsp)
                    }
                }
            })
            .await?;
        if parts[4] == "remove" || s(&result, "status") == "suspended" {
            state.browsers.revoke(&id).await;
        }
        return Ok(Some(Reply::json(result)));
    }
    if write && parts.len() == 5 && parts[1] == "dsp" && parts[2] == "jobs" && parts[4] == "cancel"
    {
        let input = i.clone();
        let job = parts[3].to_owned();
        let (context, result, active_revision) = state
            .run(move |db| {
                let c = input.context(db, "collect")?;
                v::fields(&input.body, &[])?;
                let row = db.job(&job, Some(s(&c.dsp, "id")))?;
                let active_revision =
                    if ["running", "waiting_verification"].contains(&s(&row, "status")) {
                        Some(super::db::n(&row, "connection_revision"))
                    } else {
                        None
                    };
                let result = db.cancel_job(&job, s(&c.dsp, "id"))?;
                db.audit(
                    Some(s(&c.auth.user, "id")),
                    Some(s(&c.dsp, "id")),
                    "collection.cancelled",
                    "",
                )?;
                Ok((c, result, active_revision))
            })
            .await?;
        if let Some(revision) = active_revision {
            state
                .browsers
                .revoke_revision(s(&context.dsp, "id"), revision)
                .await;
        }
        state
            .run(move |db| {
                db.revalidate(&context, "collect")?;
                Ok(())
            })
            .await?;
        return Ok(Some(Reply::json(result)));
    }
    if parts.len() < 4 || parts[1] != "dsp" || parts[2] != "connections" || parts[3] != "paycom" {
        return Ok(None);
    }
    let action = parts.get(4).copied().unwrap_or("save");
    if (action == "screenshot" && write) || (action != "screenshot" && !write) || parts.len() > 5 {
        return Ok(None);
    }
    if ![
        "save",
        "check",
        "verify",
        "disable",
        "screenshot",
        "assist",
        "submit",
    ]
    .contains(&action)
    {
        return Ok(None);
    }
    let input = i.clone();
    let c = state
        .run(move |db| input.context(db, "connections"))
        .await?;
    let id = s(&c.dsp, "id").to_owned();
    let b = &i.body;
    let _operation = if ["save", "check", "disable"].contains(&action) {
        Some(state.browsers.operation(&id)?)
    } else {
        None
    };
    match action {
        "save" => {
            browsers::validate_credentials(b)?;
            let context = c.clone();
            state
                .run(move |db| {
                    db.revalidate(&context, "connections")?;
                    db.cancel_dsp(s(&context.dsp, "id"))
                })
                .await?;
            state.browsers.revoke(&id).await;
            let context = c.clone();
            let value = b.clone();
            state
                .run(move |db| db.save_credentials(&context, &value))
                .await?;
            state.ensure_browser(&id, true).await?;
        }
        "check" => {
            v::fields(b, &[])?;
            state.ensure_browser(&id, true).await?;
        }
        "disable" => {
            v::fields(b, &["removeCredentials"])?;
            let remove = b
                .get("removeCredentials")
                .map(|_| v::boolean(b, "removeCredentials"))
                .transpose()?
                .unwrap_or(false);
            let context = c.clone();
            state
                .run(move |db| {
                    db.revalidate(&context, "connections")?;
                    db.cancel_dsp(s(&context.dsp, "id"))
                })
                .await?;
            state.browsers.revoke(&id).await;
            let context = c.clone();
            state.run(move |db| db.disable(&context, remove)).await?;
        }
        _ => {
            let session = state
                .browsers
                .get(&id)
                .ok_or_else(|| Error::new("verification_expired", 409))?;
            if action != "verify" {
                let input = if action == "screenshot" { &i.query } else { b };
                v::fields(
                    input,
                    if action == "assist" {
                        &["sessionId", "input"]
                    } else {
                        &["sessionId"]
                    },
                )?;
                ensure(
                    v::text(input, "sessionId", 36, 36)? == session.id,
                    "verification_expired",
                    409,
                )?;
            }
            let (command, types, timeout) = match action {
                "verify" => {
                    v::fields(b, &["code"])?;
                    (
                        json!({"action":"verify","code":v::text(b,"code",1,128)?}),
                        vec!["ready", "challenge"],
                        180,
                    )
                }
                "screenshot" => {
                    ensure(session.interactive(), "verification_expired", 409)?;
                    (json!({"action":"screenshot"}), vec!["screenshot"], 10)
                }
                "assist" => {
                    ensure(session.interactive(), "verification_expired", 409)?;
                    validate_browser_input(&b["input"])?;
                    (
                        json!({"action":"assist","input":b["input"]}),
                        vec!["assisted"],
                        15,
                    )
                }
                _ => {
                    if session.ready() {
                        let context = c.clone();
                        state
                            .run(move |db| db.revalidate(&context, "connections"))
                            .await?;
                        return Ok(Some(Reply::json(state.connection(&id).await?)));
                    }
                    (
                        json!({"action":"complete_assistance"}),
                        vec!["ready", "challenge"],
                        180,
                    )
                }
            };
            let result = session
                .request_guarded(command, &types, timeout, Some((state, &c)))
                .await;
            if ["verify", "submit"].contains(&action) {
                state.browser_result(&session, &result).await?;
            }
            match result {
                Ok(value) => {
                    let context = c.clone();
                    state
                        .run(move |db| db.revalidate(&context, "connections"))
                        .await?;
                    if action == "screenshot" {
                        return Ok(Some(Reply::json(
                            json!({"image":value["image"],"sessionId":session.id}),
                        )));
                    }
                    if action == "assist" {
                        return Ok(Some(Reply::ok()));
                    }
                    ensure(
                        action != "submit" || session.ready(),
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
                                "",
                            )
                        })
                        .await?;
                }
                Err(error) => {
                    if ![
                        "verification_incomplete",
                        "invalid_verification_code",
                        "connection_busy",
                    ]
                    .contains(&error.code.as_str())
                    {
                        state.browsers.revoke_current(&session).await;
                    }
                    return Err(error);
                }
            }
        }
    }
    state
        .run(move |db| db.revalidate(&c, "connections"))
        .await?;
    Ok(Some(Reply::json(state.connection(&id).await?)))
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
