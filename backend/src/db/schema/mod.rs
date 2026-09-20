//! The migration list of every database kind. See `migrations` for the rules.
//! Each 0001 creates what a new database needs and changes nothing on a database
//! that older code created, which is how those were adopted.
use super::{
    Db,
    migrations::{Apply::Code, Apply::Sql, Migration, add_column},
};
use crate::Result;

pub const PLATFORM: &[Migration] = &[
    Migration {
        id: 1,
        name: "baseline",
        apply: Sql(include_str!("platform/0001_baseline.sql")),
    },
    // The baseline has these columns. A database older than each of them gained it
    // from that release's startup, or gains it here.
    Migration {
        id: 2,
        name: "role_columns_and_indexes",
        apply: Code(role_columns),
    },
    Migration {
        id: 3,
        name: "audit_actor_name",
        apply: Code(audit_actor_name),
    },
    Migration {
        id: 4,
        name: "audit_data_and_shown",
        apply: Code(audit_data_and_shown),
    },
    Migration {
        id: 5,
        name: "outbox_context",
        apply: Code(outbox_context),
    },
];
pub const JOBS: &[Migration] = &[Migration {
    id: 1,
    name: "baseline",
    apply: Sql(include_str!("jobs/0001_baseline.sql")),
}];
pub const DSP: &[Migration] = &[Migration {
    id: 1,
    name: "baseline",
    apply: Sql(include_str!("dsp/0001_baseline.sql")),
}];
pub const PAYCOM: &[Migration] = &[Migration {
    id: 1,
    name: "baseline",
    apply: Sql(include_str!("paycom/0001_baseline.sql")),
}];
pub const CORTEX: &[Migration] = &[Migration {
    id: 1,
    name: "baseline",
    apply: Sql(include_str!("cortex/0001_baseline.sql")),
}];

fn role_columns(db: &Db) -> Result<()> {
    add_column(db, "memberships", "role_id", "TEXT REFERENCES roles(id)")?;
    add_column(db, "invitations", "role_id", "TEXT")?;
    // Here rather than in the baseline, which would fail on a database without the columns.
    db.0.execute_batch(
        "CREATE INDEX IF NOT EXISTS memberships_role ON memberships(role_id); \
        CREATE INDEX IF NOT EXISTS invitations_role ON invitations(role_id) WHERE used_at IS NULL;",
    )?;
    Ok(())
}
// Names the actor once their account is deleted.
fn audit_actor_name(db: &Db) -> Result<()> {
    add_column(db, "audit", "actor_name", "TEXT")
}
// What a queued message was for, so Diagnostics can follow an invitation from the email
// to the moment it is accepted. Mail queued before this has none.
fn outbox_context(db: &Db) -> Result<()> {
    add_column(db, "outbox", "kind", "TEXT")?;
    add_column(db, "outbox", "invitation_hash", "TEXT")?;
    add_column(db, "outbox", "user_id", "TEXT")
}
// data: who or what an event touched, and the values it changed, as JSON.
// shown: set when a platform owner acted in a DSP that shows Platform support.
fn audit_data_and_shown(db: &Db) -> Result<()> {
    add_column(db, "audit", "data", "TEXT")?;
    add_column(db, "audit", "shown", "INTEGER")
}
