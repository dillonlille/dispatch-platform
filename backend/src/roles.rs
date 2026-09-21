use super::{
    Error, Result,
    accounts::Context,
    contracts::Role,
    crypto,
    db::{Db, FromRow, Row, Store, iso, now, s},
    ensure,
};
use rusqlite::params;
use serde_json::json;

const ROLES: &str = "SELECT r.*,\
    (SELECT count(*) FROM memberships m WHERE m.role_id=r.id) members,\
    (SELECT count(*) FROM invitations i WHERE i.role_id=r.id AND i.used_at IS NULL \
     AND i.expires_at>?1) invitations \
    FROM roles r WHERE r.dsp_id=?2 ORDER BY r.system DESC,r.created_at,r.name";
const ROLE_USES: &str = "SELECT (SELECT count(*) FROM memberships WHERE role_id=?1)+\
    (SELECT count(*) FROM invitations WHERE role_id=?1 AND used_at IS NULL AND expires_at>?2)";

// Every permission a DSP owner can grant. Owners implicitly hold all of them,
// so additions here reach owners without touching stored roles.
pub const PERMISSIONS: &[&str] = &[
    "timecard.view",
    "timecard.manage",
    "collections.run",
    "connections.manage",
    "members.invite",
    "members.manage",
    "roles.manage",
    "settings.manage",
];
// Any membership satisfies this; it guards pages every member may open.
pub const ACCESS: &str = "access";
const IMPLIED: &[(&str, &str)] = &[("timecard.manage", "timecard.view")];
const DEFAULTS: &[(&str, &str, &[&str])] = &[
    ("manager", "Manager", &["timecard.view", "collections.run"]),
    ("member", "Member", &["timecard.view"]),
];

pub fn all() -> Vec<String> {
    PERMISSIONS.iter().map(|p| (*p).to_owned()).collect()
}
// Granted permissions have no previous value; revoked ones have no new value.
fn permission_changes(before: &[String], after: &[String]) -> Vec<super::db::AuditChange> {
    let missing = |from: &[String], p: &String| !from.contains(p);
    let added = after.iter().filter(|p| missing(before, p));
    let removed = before.iter().filter(|p| missing(after, p));
    added
        .map(|p| ("permission", None, Some(p.clone())))
        .chain(removed.map(|p| ("permission", Some(p.clone()), None)))
        .collect()
}
// What a stored list grants: known permissions only, in their canonical order.
fn stored(system: bool, permissions: &str) -> Vec<String> {
    if system {
        return all();
    }
    let saved: Vec<String> = serde_json::from_str(permissions).unwrap_or_default();
    PERMISSIONS
        .iter()
        .filter(|p| saved.iter().any(|v| v == *p))
        .map(|p| (*p).to_owned())
        .collect()
}
/// A row of `roles`. `system` marks the owner role, which holds every permission.
#[derive(Clone)]
pub struct RoleRow {
    pub id: String,
    pub name: String,
    pub system: bool,
    pub permissions: Vec<String>,
}
impl FromRow for RoleRow {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        let system = row.get("system")?;
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            system,
            permissions: stored(system, &row.get::<String>("permissions")?),
        })
    }
}
impl RoleRow {
    pub fn legacy(&self) -> &'static str {
        legacy(self.system, &self.permissions)
    }
    fn public(self, counts: Option<(i64, i64)>) -> Role {
        Role {
            id: self.id,
            name: self.name,
            owner: self.system,
            permissions: self.permissions,
            members: counts.map(|(members, _)| members),
            invitations: counts.map(|(_, invitations)| invitations),
        }
    }
}
struct CountedRole(Role);
impl FromRow for CountedRole {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        let counts = (row.get("members")?, row.get("invitations")?);
        Ok(Self(RoleRow::from_row(row)?.public(Some(counts))))
    }
}
// The legacy role column stays populated so an older Rust runtime keeps
// working after rollback, never with more access than the role grants.
fn legacy(system: bool, permissions: &[String]) -> &'static str {
    if system {
        "owner"
    } else if permissions.iter().any(|p| p == "collections.run") {
        "manager"
    } else {
        "member"
    }
}

// Seeds every DSP's default roles, and gives a role_id to each membership and
// invitation that has only the legacy role.
pub fn backfill(db: &Db) -> Result<()> {
    db.transaction(|| {
        for dsp in db.all("SELECT id FROM dsps", [])? {
            seed(db, s(&dsp, "id"))?;
        }
        for table in ["memberships", "invitations"] {
            for row in db.all(
                &format!("SELECT DISTINCT dsp_id,role FROM {table} WHERE role_id IS NULL"),
                [],
            )? {
                let id = default_role(db, s(&row, "dsp_id"), s(&row, "role"))?;
                db.exec(
                    &format!(
                        "UPDATE {table} SET role_id=? WHERE role_id IS NULL AND dsp_id=? AND role=?"
                    ),
                    [&id, s(&row, "dsp_id"), s(&row, "role")],
                )?;
            }
        }
        Ok(())
    })
}
pub fn seed(db: &Db, dsp: &str) -> Result<()> {
    if db
        .one("SELECT id FROM roles WHERE dsp_id=? LIMIT 1", [dsp])?
        .is_some()
    {
        return Ok(());
    }
    for role in ["owner", "manager", "member"] {
        default_role(db, dsp, role)?;
    }
    Ok(())
}
// Finds the role a legacy value maps to, restoring a deleted default when an
// older runtime wrote a membership that still needs one.
pub fn default_role(db: &Db, dsp: &str, role: &str) -> Result<String> {
    let (name, system, permissions): (&str, bool, &[&str]) = match role {
        "owner" => ("Owner", true, &[]),
        other => DEFAULTS
            .iter()
            .find(|d| d.0 == other)
            .map(|d| (d.1, false, d.2))
            .ok_or_else(|| Error::new("invalid_role", 400))?,
    };
    let found = if system {
        db.one("SELECT id FROM roles WHERE dsp_id=? AND system=1", [dsp])?
    } else {
        db.one(
            "SELECT id FROM roles WHERE dsp_id=? AND system=0 AND name=?",
            [dsp, name],
        )?
    };
    if let Some(row) = found {
        return Ok(s(&row, "id").to_owned());
    }
    let id = crypto::id("role")?;
    db.exec(
        "INSERT INTO roles(id,dsp_id,name,permissions,system,created_at) VALUES (?,?,?,?,?,?)",
        params![id, dsp, name, json!(permissions).to_string(), system, iso()],
    )?;
    Ok(id)
}

pub struct Grant {
    pub id: String,
    pub name: String,
    pub owner: bool,
    pub permissions: Vec<String>,
}
impl From<RoleRow> for Grant {
    fn from(row: RoleRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            owner: row.system,
            permissions: row.permissions,
        }
    }
}
impl Store {
    // A member's effective role. Rows written by an older runtime have no
    // role_id yet, so they resolve through the legacy value without writing.
    pub fn grant(&self, user: &str, dsp: &str) -> Result<Option<Grant>> {
        let member: Option<(String, Option<String>)> = self.platform.one_as(
            "SELECT role,role_id FROM memberships WHERE user_id=? AND dsp_id=?",
            [user, dsp],
        )?;
        let Some((legacy, role_id)) = member else {
            return Ok(None);
        };
        let row: Option<RoleRow> = if let Some(id) = &role_id {
            self.find_role(dsp, id)?
        } else if legacy == "owner" {
            self.platform
                .one_as("SELECT * FROM roles WHERE dsp_id=? AND system=1", [dsp])?
        } else {
            let name = DEFAULTS.iter().find(|d| d.0 == legacy).map_or("", |d| d.1);
            self.platform.one_as(
                "SELECT * FROM roles WHERE dsp_id=? AND system=0 AND name=?",
                [dsp, name],
            )?
        };
        Ok(row.map(Grant::from))
    }
    pub fn owner_role(&self, dsp: &str) -> Result<String> {
        default_role(&self.platform, dsp, "owner")
    }
    pub fn find_role(&self, dsp: &str, id: &str) -> Result<Option<RoleRow>> {
        self.platform
            .one_as("SELECT * FROM roles WHERE id=? AND dsp_id=?", [id, dsp])
    }
    pub fn role(&self, dsp: &str, id: &str) -> Result<RoleRow> {
        self.find_role(dsp, id)?
            .ok_or_else(|| Error::new("role_not_found", 404))
    }
    pub fn roles(&self, dsp: &str) -> Result<Vec<Role>> {
        let roles: Vec<CountedRole> = self.platform.query_as(ROLES, params![now(), dsp])?;
        Ok(roles.into_iter().map(|role| role.0).collect())
    }
    // Nobody hands out access they do not hold: the owner role is reserved for
    // owners, and any other role must fit inside the actor's own permissions.
    pub fn ensure_assignable(&self, c: &Context, role: &RoleRow) -> Result<()> {
        ensure(
            if role.system {
                c.owner
            } else {
                role.permissions.iter().all(|p| c.can(p))
            },
            "role_exceeds_permissions",
            403,
        )
    }
    fn role_input(c: &Context, name: &str, requested: &[String]) -> Result<(String, Vec<String>)> {
        let name = name.trim();
        ensure(
            (1..=40).contains(&name.chars().count()) && !name.eq_ignore_ascii_case("owner"),
            "invalid_role_name",
            400,
        )?;
        ensure(
            requested.iter().all(|p| PERMISSIONS.contains(&p.as_str())),
            "invalid_input",
            400,
        )?;
        let mut wanted = requested.to_vec();
        for (permission, implied) in IMPLIED {
            if wanted.iter().any(|p| p == permission) && !wanted.iter().any(|p| p == implied) {
                wanted.push((*implied).to_owned());
            }
        }
        ensure(
            wanted.iter().all(|p| c.can(p)),
            "role_exceeds_permissions",
            403,
        )?;
        let ordered = PERMISSIONS
            .iter()
            .filter(|p| wanted.iter().any(|v| v == *p))
            .map(|p| (*p).to_owned())
            .collect();
        Ok((name.to_owned(), ordered))
    }
    fn ensure_name_free(&self, dsp: &str, name: &str, except: &str) -> Result<()> {
        ensure(
            self.platform
                .one(
                    "SELECT id FROM roles WHERE dsp_id=? AND name=? AND id<>?",
                    [dsp, name, except],
                )?
                .is_none(),
            "role_name_taken",
            409,
        )
    }
    pub fn create_role(&self, c: &Context, name: &str, permissions: &[String]) -> Result<Role> {
        let dsp = c.dsp.id.as_str();
        let (name, permissions) = Self::role_input(c, name, permissions)?;
        self.platform.transaction(|| {
            self.ensure_name_free(dsp, &name, "")?;
            let count = self
                .platform
                .count("SELECT count(*) FROM roles WHERE dsp_id=?", [dsp])?;
            ensure(count < 50, "role_limit", 409)?;
            let id = crypto::id("role")?;
            self.platform.exec(
                "INSERT INTO roles(id,dsp_id,name,permissions,created_at) VALUES (?,?,?,?,?)",
                params![id, dsp, name, json!(permissions).to_string(), iso()],
            )?;
            self.audit_ref(
                Some(c.actor()),
                Some(dsp),
                "role.created",
                &name,
                Some(&name),
                &permission_changes(&[], &permissions),
                Some(("role", &id)),
            )?;
            Ok(self.role(dsp, &id)?.public(None))
        })
    }
    pub fn update_role(
        &self,
        c: &Context,
        id: &str,
        name: &str,
        permissions: &[String],
    ) -> Result<Role> {
        let dsp = c.dsp.id.as_str();
        let (name, permissions) = Self::role_input(c, name, permissions)?;
        self.platform.transaction(|| {
            let role = self.role(dsp, id)?;
            ensure(!role.system, "owner_role_locked", 409)?;
            self.ensure_assignable(c, &role)?;
            self.ensure_name_free(dsp, &name, id)?;
            self.platform.exec(
                "UPDATE roles SET name=?,permissions=? WHERE id=?",
                params![name, json!(permissions).to_string(), id],
            )?;
            let mirror = legacy(false, &permissions);
            self.platform.exec(
                "UPDATE memberships SET role=? WHERE role_id=?",
                [mirror, id],
            )?;
            self.platform.exec(
                "UPDATE invitations SET role=? WHERE role_id=? AND used_at IS NULL",
                [mirror, id],
            )?;
            // Open views sign the DSP revision, so members pick up the change.
            self.platform
                .exec("UPDATE dsps SET revision=revision+1 WHERE id=?", [dsp])?;
            let mut changes = permission_changes(&role.permissions, &permissions);
            if role.name != name {
                changes.insert(0, ("name", Some(role.name.clone()), Some(name.clone())));
            }
            self.audit_ref(
                Some(c.actor()),
                Some(dsp),
                "role.updated",
                &name,
                Some(&role.name),
                &changes,
                Some(("role", id)),
            )?;
            Ok(self.role(dsp, id)?.public(None))
        })
    }
    pub fn delete_role(&self, c: &Context, id: &str) -> Result<()> {
        let dsp = c.dsp.id.as_str();
        self.platform.transaction(|| {
            let role = self.role(dsp, id)?;
            ensure(!role.system, "owner_role_locked", 409)?;
            self.ensure_assignable(c, &role)?;
            let used = self.platform.count(ROLE_USES, params![id, now()])?;
            ensure(used == 0, "role_in_use", 409)?;
            self.platform.exec(
                "DELETE FROM invitations WHERE role_id=? AND used_at IS NULL",
                [id],
            )?;
            self.platform.exec("DELETE FROM roles WHERE id=?", [id])?;
            self.audit_ref(
                Some(c.actor()),
                Some(dsp),
                "role.deleted",
                &role.name,
                Some(&role.name),
                &[],
                Some(("role", id)),
            )
        })
    }
}
