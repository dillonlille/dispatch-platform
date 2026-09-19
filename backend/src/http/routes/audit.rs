//! The audit log, for one DSP and for the whole platform.
use crate::{
    Result,
    db::{AuditQuery, Store},
    ensure,
    http::{
        input::{Input, Reply, optional_text, query_number},
        route::{Dsp, Member, PlatformOwner, Route, User, read, write},
    },
    validate as v,
};
use serde_json::Value;

const VIEW: Dsp = Dsp("audit.view");
const AREAS: &[&str] = &[
    "",
    "team",
    "roles",
    "collections",
    "schedules",
    "connections",
    "access",
    "dsps",
    "settings",
    "failures",
];

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/audit", VIEW, dsp_audit),
        write("/api/dsp/audit/export", VIEW, export_dsp_audit),
        read("/api/platform/audit", PlatformOwner, platform_audit),
        write(
            "/api/platform/audit/export",
            PlatformOwner,
            export_platform_audit,
        ),
    ]
}

fn dsp_audit(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let query = audit_query(&input.query, Some(c.dsp_id()))?;
    Ok(Reply::json(db.audit_page(&query)?))
}

// Exporting is itself recorded, which is why it is a write.
fn export_dsp_audit(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let query = audit_query(&input.body, Some(c.dsp_id()))?;
    Ok(Reply::json(db.audit_export(c.actor(), query)?))
}

fn platform_audit(db: &Store, _: &User, input: &Input) -> Result<Reply> {
    Ok(Reply::json(
        db.audit_page(&audit_query(&input.query, None)?)?,
    ))
}

fn export_platform_audit(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    let query = audit_query(&input.body, None)?;
    Ok(Reply::json(db.audit_export(owner.actor(), query)?))
}

fn audit_query<'a>(q: &'a Value, dsp: Option<&'a str>) -> Result<AuditQuery<'a>> {
    v::fields(
        q,
        &[
            "area", "actor", "q", "from", "before", "limit", "dsp", "subject", "named",
        ],
    )?;
    let area = optional_text(q, "area", 20)?;
    ensure(AREAS.contains(&area), "invalid_input", 400)?;
    Ok(AuditQuery {
        dsp,
        area,
        actor: optional_text(q, "actor", 200)?,
        q: optional_text(q, "q", 100)?,
        from: optional_text(q, "from", 40)?,
        before: query_number(q, "before", 0, 0, usize::MAX >> 1)? as i64,
        limit: query_number(q, "limit", 50, 1, 5000)? as i64,
        // A DSP's own log is already one DSP's; only the platform narrows further.
        within: if dsp.is_none() {
            optional_text(q, "dsp", 100)?
        } else {
            ""
        },
        subject: optional_text(q, "subject", 200)?,
        named: optional_text(q, "named", 200)?,
    })
}
