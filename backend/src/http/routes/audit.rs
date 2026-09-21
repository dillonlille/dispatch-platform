//! The audit log, available only to platform owners.
use crate::{
    Result,
    db::{AuditQuery, Store},
    ensure,
    http::{
        input::{Input, Reply, optional_text, query_number},
        route::{PlatformOwner, Route, User, read, write},
    },
    validate as v,
};
use serde_json::Value;

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
        read("/api/platform/audit", PlatformOwner, platform_audit),
        write(
            "/api/platform/audit/export",
            PlatformOwner,
            export_platform_audit,
        ),
    ]
}

fn platform_audit(db: &Store, _: &User, input: &Input) -> Result<Reply> {
    Reply::of(&db.audit_page(&audit_query(&input.query)?)?)
}

fn export_platform_audit(db: &Store, owner: &User, input: &Input) -> Result<Reply> {
    let query = audit_query(&input.body)?;
    Reply::of(&db.audit_export(owner.actor(), query)?)
}

fn audit_query(q: &Value) -> Result<AuditQuery<'_>> {
    v::fields(
        q,
        &[
            "area", "actor", "q", "from", "before", "limit", "dsp", "subject", "named",
        ],
    )?;
    let area = optional_text(q, "area", 20)?;
    ensure(AREAS.contains(&area), "invalid_input", 400)?;
    Ok(AuditQuery {
        dsp: None,
        area,
        actor: optional_text(q, "actor", 200)?,
        q: optional_text(q, "q", 100)?,
        from: optional_text(q, "from", 40)?,
        before: query_number(q, "before", 0, 0, usize::MAX >> 1)? as i64,
        limit: query_number(q, "limit", 50, 1, 5000)? as i64,
        within: optional_text(q, "dsp", 100)?,
        subject: optional_text(q, "subject", 200)?,
        named: optional_text(q, "named", 200)?,
    })
}
