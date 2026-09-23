//! What only a platform owner sees: every DSP, the platform's health and diagnostics.
use crate::{
    Error, Result, State,
    contracts::{BrowserHealth, DspStatus, JobStatus, PlatformHealth, ProviderMode},
    db::{Store, iso},
    ensure,
    http::{
        input::{Input, Reply, optional},
        route::{Grant, PlatformOwner, Route, User, async_post, read, write},
    },
    mail, operations, validate as v, workforce,
};
use serde_json::{Value, json};
use std::sync::Arc;

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
        read("/api/platform/mail", PlatformOwner, mail_log),
        write("/api/platform/mail/{id}/retry", PlatformOwner, retry_mail),
        write(
            "/api/platform/mail/{id}/discard",
            PlatformOwner,
            discard_mail,
        ),
        read("/api/platform/diagnostics", PlatformOwner, diagnostics),
        write("/api/platform/diagnostics", PlatformOwner, load_test_dsp),
    ]
}

fn dsps(db: &Store, owner: &User, _: &Input) -> Result<Reply> {
    Reply::of(&super::session::summaries(db, owner)?)
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
    let dsp = db.new_dsp(&name, &tz, owner.actor(), false)?;
    let id = dsp.id.as_str();
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
    Reply::of(&db.find_dsp(id)?)
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
            change(db, &dsp, owner.user.id.as_str(), &input.body)
        })
        .await?;
    if closes_browsers || result["status"] == DspStatus::Suspended.as_str() {
        state.browsers.revoke(&id).await;
    }
    Ok(Reply::json(result))
}

async fn set_status(state: Arc<State>, input: Input, access: PlatformOwner) -> Result<Reply> {
    change_dsp(state, input, access, false, |db, dsp, actor, b| {
        v::fields(b, &["status"])?;
        let status = v::choice(b, "status", &["active", "suspended"])?;
        let status = DspStatus::parse(status).ok_or_else(|| Error::new("invalid_input", 400))?;
        let row = db.set_status(dsp, status, actor)?;
        if status == DspStatus::Suspended {
            db.cancel_dsp(dsp)?;
        }
        Ok(json!(row))
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
        db.find_dsp(dsp)?;
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
        db.set_status(dsp, DspStatus::Suspended, actor)?;
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
        let row = db.find_dsp(dsp)?;
        ensure(
            !row.permanent && db.profile(dsp)?.removed,
            "dsp_not_removed",
            409,
        )?;
        db.set_profile(dsp, json!({"removed":false}))?;
        let row = db.set_status(dsp, DspStatus::Active, actor)?;
        db.audit(Some(actor), Some(dsp), "dsp.restored", "")?;
        Ok(json!(row))
    })
    .await
}

fn mail_log(db: &Store, _: &User, _: &Input) -> Result<Reply> {
    Reply::of(&crate::mail::log(db)?)
}
fn retry_mail(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    crate::mail::retry(db, &owner.user.id, input.param("id"))?;
    Reply::of(&json!({ "ok": true }))
}
fn discard_mail(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    crate::mail::discard(db, &owner.user.id, input.param("id"))?;
    Reply::of(&json!({ "ok": true }))
}
fn health(db: &Store, owner: &User, _: &Input) -> Result<Reply> {
    let state = owner.state;
    let counts = db
        .jobs
        .query_as::<(JobStatus, u32)>("SELECT status,count(*) n FROM jobs GROUP BY status", [])?
        .into_iter()
        .collect();
    Reply::of(&PlatformHealth {
        environment: db.config.env(),
        release: db.config.release.clone(),
        jobs: counts,
        browsers: BrowserHealth {
            active: state.browsers.active(),
            capacity: db.config.browser_capacity,
            memory: state.browsers.admission(),
        },
        dsps: db.platform.count("SELECT count(*) FROM dsps", [])?,
        email: db.config.mail_available(),
        mail: mail::health(db, state)?,
        provider_mode: if db.config.fixture {
            ProviderMode::Fixture
        } else {
            ProviderMode::Native
        },
    })
}

fn diagnostics(db: &Store, owner: &User, _: &Input) -> Result<Reply> {
    Ok(Reply::json(diagnostics_report(db, owner.state)?))
}

fn load_test_dsp(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    ensure(
        db.config.development || db.config.env().is_preview(),
        "test_dsps_unavailable",
        409,
    )?;
    let name = format!("Test DSP {}", iso());
    let dsp = db.new_dsp(&name, "America/Chicago", owner.actor(), false)?;
    let id = dsp.id.as_str();
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
        "enabled":db.config.development || db.config.env().is_preview(),
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
