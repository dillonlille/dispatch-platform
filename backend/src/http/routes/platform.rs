//! What only a platform owner sees: every DSP, the platform's health, diagnostics and releases.
use crate::{
    Result, State,
    db::{Store, flag, iso, s},
    ensure,
    http::{
        input::{Input, Reply, optional},
        route::{Grant, PlatformOwner, Route, User, async_post, read, write},
    },
    mail, operations, validate as v, workforce,
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

const TEST_DSPS: &str = "SELECT d.id,d.name,d.status FROM dsps d WHERE EXISTS \
    (SELECT 1 FROM audit a WHERE a.dsp_id=d.id AND a.action='diagnostics.fixtures_loaded') \
    ORDER BY d.created_at DESC";

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/platform/dsps", PlatformOwner, dsps),
        write("/api/platform/dsps", PlatformOwner, create_dsp).invalidates_schedules(),
        write("/api/platform/dsps/{id}/retry", PlatformOwner, retry_dsp).invalidates_schedules(),
        async_post("/api/platform/dsps/{id}/status", PlatformOwner, set_status),
        async_post(
            "/api/platform/dsps/{id}/support-visibility",
            PlatformOwner,
            set_support_visibility,
        ),
        async_post("/api/platform/dsps/{id}/remove", PlatformOwner, remove_dsp),
        async_post(
            "/api/platform/dsps/{id}/restore",
            PlatformOwner,
            restore_dsp,
        ),
        read("/api/platform/health", PlatformOwner, health),
        read("/api/platform/diagnostics", PlatformOwner, diagnostics),
        write("/api/platform/diagnostics", PlatformOwner, load_test_dsp),
        read("/api/platform/releases", PlatformOwner, releases),
    ]
}

fn dsps(db: &Store, owner: &User, _: &Input) -> Result<Reply> {
    Ok(Reply::json(db.dsps(owner)?))
}

// A DSP is created either by name, or for an invited owner who then names it.
fn create_dsp(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    let b = &input.body;
    v::fields(b, &["name", "timezone", "ownerEmail"])?;
    ensure(
        b.get("name").is_some() || b.get("ownerEmail").is_some(),
        "invalid_input",
        400,
    )?;
    let given = optional(b, "name", |b, key| v::name(b, key, 100))?;
    let named = given.is_some();
    let name = given.unwrap_or_else(|| "New DSP".into());
    let tz = optional(b, "timezone", v::timezone)?.unwrap_or_else(|| "UTC".into());
    let email = optional(b, "ownerEmail", v::email)?;
    if email.is_some() {
        ensure(db.config.mail_available(), "email_unavailable", 503)?;
    }
    let dsp = db.create_dsp(&name, &tz, owner.actor(), false)?;
    let id = s(&dsp, "id");
    if !named {
        db.set_profile(id, json!({"setupRequired":true}))?;
    }
    let mut out = json!({"dsp":dsp});
    if let Some(email) = email {
        db.platform.transaction(|| {
            let raw = db.invite(owner, id, &email, &db.owner_role(id)?)?;
            db.invitation_mail(owner, &email, &name, "Owner", &raw, !named)
        })?;
        out["invitation"] = json!({"email":email,"status":"queued"});
    }
    Ok(Reply::status(out, 201))
}

fn retry_dsp(db: &Store, _: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    let id = input.param("id");
    db.provision(id)?;
    Ok(Reply::json(db.get_dsp(id)?))
}

// The four changes below close the DSP's browsers once the database step has
// succeeded, which is why they are async. None of them wakes the scheduler.
async fn change_dsp(
    state: Arc<State>,
    input: Input,
    access: PlatformOwner,
    closes_browsers: bool,
    change: fn(&Store, &str, &str, &Value) -> Result<Value>,
) -> Result<Reply> {
    let id = input.param("id").to_owned();
    let dsp = id.clone();
    let result = state
        .run(move |db| {
            let owner = access.authorize(db, &input)?;
            change(db, &dsp, s(&owner.user, "id"), &input.body)
        })
        .await?;
    if closes_browsers || s(&result, "status") == "suspended" {
        state.browsers.revoke(&id).await;
    }
    Ok(Reply::json(result))
}

async fn set_status(state: Arc<State>, input: Input, access: PlatformOwner) -> Result<Reply> {
    change_dsp(state, input, access, false, |db, dsp, actor, b| {
        v::fields(b, &["status"])?;
        let status = v::choice(b, "status", &["active", "suspended"])?;
        let row = db.set_status(dsp, status, actor)?;
        if status == "suspended" {
            db.cancel_dsp(dsp)?;
        }
        Ok(row)
    })
    .await
}

async fn set_support_visibility(
    state: Arc<State>,
    input: Input,
    access: PlatformOwner,
) -> Result<Reply> {
    change_dsp(state, input, access, false, |db, dsp, actor, b| {
        v::fields(b, &["visible"])?;
        let visible = v::boolean(b, "visible")?;
        db.get_dsp(dsp)?;
        db.set_profile(dsp, json!({"supportVisible":visible}))?;
        let detail = if visible { "shown" } else { "hidden" };
        db.audit(
            Some(actor),
            Some(dsp),
            "dsp.support_visibility_changed",
            detail,
        )?;
        Ok(json!({"ok":true}))
    })
    .await
}

async fn remove_dsp(state: Arc<State>, input: Input, access: PlatformOwner) -> Result<Reply> {
    change_dsp(state, input, access, true, |db, dsp, actor, b| {
        v::fields(b, &[])?;
        db.set_status(dsp, "suspended", actor)?;
        db.set_profile(dsp, json!({"removed":true}))?;
        db.cancel_dsp(dsp)?;
        db.audit(Some(actor), Some(dsp), "dsp.removed", "")?;
        Ok(json!({"ok":true}))
    })
    .await
}

async fn restore_dsp(state: Arc<State>, input: Input, access: PlatformOwner) -> Result<Reply> {
    change_dsp(state, input, access, false, |db, dsp, actor, b| {
        v::fields(b, &[])?;
        let row = db.get_dsp(dsp)?;
        ensure(
            !flag(&row, "permanent") && flag(&db.profile(dsp)?, "removed"),
            "dsp_not_removed",
            409,
        )?;
        db.set_profile(dsp, json!({"removed":false}))?;
        let row = db.set_status(dsp, "active", actor)?;
        db.audit(Some(actor), Some(dsp), "dsp.restored", "")?;
        Ok(row)
    })
    .await
}

fn health(db: &Store, owner: &User, _: &Input) -> Result<Reply> {
    let state = owner.state;
    let counts: HashMap<String, Value> = db
        .jobs
        .all("SELECT status,count(*) n FROM jobs GROUP BY status", [])?
        .into_iter()
        .map(|r| (s(&r, "status").into(), r["n"].clone()))
        .collect();
    let browsers = json!({
        "active":state.browsers.active(),
        "capacity":db.config.browser_capacity,
        "memory":state.browsers.admission()
    });
    let dsps = db.platform.one("SELECT count(*) n FROM dsps", [])?.unwrap();
    Ok(Reply::json(json!({
        "environment":db.config.environment,
        "release":db.config.release,
        "jobs":counts,
        "browsers":browsers,
        "dsps":dsps["n"],
        "email":db.config.mail_available(),
        "mail":mail::health(db, state)?,
        "providerMode":if db.config.fixture { "fixture" } else { "native" }
    })))
}

fn diagnostics(db: &Store, owner: &User, _: &Input) -> Result<Reply> {
    Ok(Reply::json(diagnostics_report(db, owner.state)?))
}

fn load_test_dsp(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    ensure(
        db.config.development || db.config.environment == "preview",
        "test_dsps_unavailable",
        409,
    )?;
    let name = format!("Test DSP {}", iso());
    let dsp = db.create_dsp(&name, "America/Chicago", owner.actor(), false)?;
    let id = s(&dsp, "id");
    db.publish(id, &workforce::fixture("America/Chicago")?)?;
    db.audit(
        Some(owner.actor()),
        Some(id),
        "diagnostics.fixtures_loaded",
        "",
    )?;
    Ok(Reply::json(diagnostics_report(db, owner.state)?))
}

fn diagnostics_report(db: &Store, state: &State) -> Result<Value> {
    let memory = operations::memory();
    Ok(json!({
        "enabled":db.config.development || db.config.environment == "preview",
        "storageAvailableBytes":operations::available_space(&db.config.root)?,
        "runtime":{
            "name":"Shared platform (Rust)",
            "status":"Running",
            "memoryBytes":memory.0 + memory.1,
            "coreMemoryBytes":memory.0,
            "workerMemoryBytes":memory.1,
            "browsers":state.browsers.active()
        },
        "dsps":db.platform.all(TEST_DSPS, [])?
    }))
}

fn releases(db: &Store, _: &User, _: &Input) -> Result<Reply> {
    let name = if db.config.environment == "production" {
        "production-update.json"
    } else {
        "dev-update.json"
    };
    let update = std::fs::read(db.config.platform().join(name))
        .ok()
        .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
        .map(|v| json!({"status":v["status"],"commit":v["commit"],"updatedAt":v["updatedAt"]}));
    Ok(Reply::json(json!({
        "version":db.config.version,
        "environment":db.config.environment,
        "release":db.config.release,
        "update":update
    })))
}
