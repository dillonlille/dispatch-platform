//! Who is signed in, and which DSP they are looking at.
use crate::{
    Result,
    contracts::{self, ProviderMode, SessionResponse},
    db::{Store, flag, s},
    ensure,
    http::{
        input::{Input, Reply},
        route::{Route, Session, User, read, write},
    },
    roles, validate as v,
};
use serde_json::json;

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/session", Session, session),
        write("/api/session/dsp", Session, open_dsp),
    ]
}

fn session(db: &Store, user: &User, _: &Input) -> Result<Reply> {
    Ok(Reply::json(serde_json::to_value(SessionResponse {
        user: contracts::request(&user.user)?,
        csrf: user.csrf.clone(),
        dsps: db.dsps(user)?,
        development: db.config.development,
        environment: SessionResponse::environment(&db.config.environment)?,
        release: db.config.release.clone(),
        provider_mode: if db.config.fixture {
            ProviderMode::Fixture
        } else {
            ProviderMode::Native
        },
    })?))
}

// Answers with the signed view token every DSP route then expects as a header.
fn open_dsp(db: &Store, user: &User, input: &Input) -> Result<Reply> {
    let b = &input.body;
    let mut a = (**user).clone();
    v::fields(b, &["dspId", "roleId"])?;
    let platform = flag(&a.user, "platformOwner");
    // Only a platform owner may look through a role other than their own.
    if !b["roleId"].is_null() {
        ensure(platform, "permission_denied", 403)?;
        a.preview = Some(v::text(b, "roleId", 1, 100)?.to_owned());
    }
    let c = db.context(&a, v::text(b, "dspId", 1, 100)?, roles::ACCESS)?;
    let action = if platform {
        "dsp.owner_view_opened"
    } else {
        "dsp.view_opened"
    };
    let previewed = if a.preview.is_some() {
        &c.role_name
    } else {
        ""
    };
    db.audit_visit(s(&a.user, "id"), s(&c.dsp, "id"), action, previewed)?;
    let mut view = json!({
        "dsp":c.dsp,
        "role":{"id":c.role,"name":c.role_name,"owner":c.owner},
        "permissions":if c.owner { roles::all() } else { c.permissions.clone() },
        "token":db.view_token(&c),
        "profile":db.profile(s(&c.dsp, "id"))?
    });
    if platform {
        view["roles"] = db
            .roles(s(&c.dsp, "id"))?
            .as_array()
            .into_iter()
            .flatten()
            .map(|role| json!({"id":role["id"],"name":role["name"],"owner":role["owner"]}))
            .collect();
    }
    Ok(Reply::json(view))
}
