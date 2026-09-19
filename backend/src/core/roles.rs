use super::{
    Error, Result,
    accounts::Context,
    crypto,
    db::{Db, Store, flag, iso, n, now, s},
    ensure,
};
use rusqlite::params;
use serde_json::{Value, json};

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
    "audit.view",
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
fn stored(row: &Value) -> Vec<String> {
    if flag(row, "system") {
        return all();
    }
    let saved: Vec<String> = serde_json::from_str(s(row, "permissions")).unwrap_or_default();
    PERMISSIONS
        .iter()
        .filter(|p| saved.iter().any(|v| v == *p))
        .map(|p| (*p).to_owned())
        .collect()
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
fn public(row: &Value) -> Value {
    json!({"id":row["id"],"name":row["name"],"owner":flag(row,"system"),"permissions":stored(row),"members":row["members"],"invitations":row["invitations"]})
}

// Nullable, additive columns keep the version 3 platform schema readable by
// the previous Rust release.
pub fn migrate(db: &Db) -> Result<()> {
    db.transaction(|| {
        db.0.execute_batch("CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, dsp_id TEXT NOT NULL REFERENCES dsps(id), name TEXT NOT NULL COLLATE NOCASE, permissions TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0 CHECK(system IN (0,1)), created_at TEXT NOT NULL, UNIQUE(dsp_id,name)); CREATE UNIQUE INDEX IF NOT EXISTS roles_owner ON roles(dsp_id) WHERE system=1;")?;
        for (table, kind) in [("memberships", "TEXT REFERENCES roles(id)"), ("invitations", "TEXT")] {
            let columns = db.all(&format!("PRAGMA table_info({table})"), [])?;
            if !columns.iter().any(|c| s(c, "name") == "role_id") {
                db.0.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN role_id {kind}"))?;
            }
        }
        db.0.execute_batch("CREATE INDEX IF NOT EXISTS memberships_role ON memberships(role_id); CREATE INDEX IF NOT EXISTS invitations_role ON invitations(role_id) WHERE used_at IS NULL;")?;
        for dsp in db.all("SELECT id FROM dsps", [])? {
            seed(db, s(&dsp, "id"))?;
        }
        for table in ["memberships", "invitations"] {
            for row in db.all(&format!("SELECT DISTINCT dsp_id,role FROM {table} WHERE role_id IS NULL"), [])? {
                let id = default_role(db, s(&row, "dsp_id"), s(&row, "role"))?;
                db.exec(&format!("UPDATE {table} SET role_id=? WHERE role_id IS NULL AND dsp_id=? AND role=?"), [&id, s(&row, "dsp_id"), s(&row, "role")])?;
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
impl Grant {
    pub fn of(row: &Value) -> Self {
        Self {
            id: s(row, "id").to_owned(),
            name: s(row, "name").to_owned(),
            owner: flag(row, "system"),
            permissions: stored(row),
        }
    }
}
impl Store {
    // A member's effective role. Rows written by an older runtime have no
    // role_id yet, so they resolve through the legacy value without writing.
    pub fn grant(&self, user: &str, dsp: &str) -> Result<Option<Grant>> {
        let Some(member) = self.platform.one(
            "SELECT role,role_id FROM memberships WHERE user_id=? AND dsp_id=?",
            [user, dsp],
        )?
        else {
            return Ok(None);
        };
        let row = if let Some(id) = member["role_id"].as_str() {
            self.platform
                .one("SELECT * FROM roles WHERE id=? AND dsp_id=?", [id, dsp])?
        } else if s(&member, "role") == "owner" {
            self.platform
                .one("SELECT * FROM roles WHERE dsp_id=? AND system=1", [dsp])?
        } else {
            let name = DEFAULTS
                .iter()
                .find(|d| d.0 == s(&member, "role"))
                .map_or("", |d| d.1);
            self.platform.one(
                "SELECT * FROM roles WHERE dsp_id=? AND system=0 AND name=?",
                [dsp, name],
            )?
        };
        Ok(row.as_ref().map(Grant::of))
    }
    pub fn owner_role(&self, dsp: &str) -> Result<String> {
        default_role(&self.platform, dsp, "owner")
    }
    pub fn role(&self, dsp: &str, id: &str) -> Result<Value> {
        self.platform
            .one("SELECT * FROM roles WHERE id=? AND dsp_id=?", [id, dsp])?
            .ok_or_else(|| Error::new("role_not_found", 404))
    }
    pub fn roles(&self, dsp: &str) -> Result<Value> {
        Ok(json!(self.platform.all("SELECT r.*,(SELECT count(*) FROM memberships m WHERE m.role_id=r.id) members,(SELECT count(*) FROM invitations i WHERE i.role_id=r.id AND i.used_at IS NULL AND i.expires_at>?1) invitations FROM roles r WHERE r.dsp_id=?2 ORDER BY r.system DESC,r.created_at,r.name",params![now(),dsp])?.iter().map(public).collect::<Vec<_>>()))
    }
    // Nobody hands out access they do not hold: the owner role is reserved for
    // owners, and any other role must fit inside the actor's own permissions.
    pub fn ensure_assignable(&self, c: &Context, role: &Value) -> Result<()> {
        ensure(
            if flag(role, "system") {
                c.owner
            } else {
                stored(role).iter().all(|p| c.can(p))
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
    pub fn create_role(&self, c: &Context, name: &str, permissions: &[String]) -> Result<Value> {
        let dsp = s(&c.dsp, "id");
        let (name, permissions) = Self::role_input(c, name, permissions)?;
        self.platform.transaction(|| {
            self.ensure_name_free(dsp, &name, "")?;
            ensure(
                n(
                    &self
                        .platform
                        .one("SELECT count(*) count FROM roles WHERE dsp_id=?", [dsp])?
                        .unwrap(),
                    "count",
                ) < 50,
                "role_limit",
                409,
            )?;
            let id = crypto::id("role")?;
            self.platform.exec(
                "INSERT INTO roles(id,dsp_id,name,permissions,created_at) VALUES (?,?,?,?,?)",
                params![id, dsp, name, json!(permissions).to_string(), iso()],
            )?;
            self.audit_ref(
                Some(s(&c.auth.user, "id")),
                Some(dsp),
                "role.created",
                &name,
                Some(&name),
                &permission_changes(&[], &permissions),
                Some(("role", &id)),
            )?;
            Ok(public(&self.role(dsp, &id)?))
        })
    }
    pub fn update_role(
        &self,
        c: &Context,
        id: &str,
        name: &str,
        permissions: &[String],
    ) -> Result<Value> {
        let dsp = s(&c.dsp, "id");
        let (name, permissions) = Self::role_input(c, name, permissions)?;
        self.platform.transaction(|| {
            let role = self.role(dsp, id)?;
            ensure(!flag(&role, "system"), "owner_role_locked", 409)?;
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
            let mut changes = permission_changes(&stored(&role), &permissions);
            if s(&role, "name") != name {
                changes.insert(
                    0,
                    (
                        "name",
                        Some(s(&role, "name").to_owned()),
                        Some(name.clone()),
                    ),
                );
            }
            self.audit_ref(
                Some(s(&c.auth.user, "id")),
                Some(dsp),
                "role.updated",
                &name,
                Some(s(&role, "name")),
                &changes,
                Some(("role", id)),
            )?;
            Ok(public(&self.role(dsp, id)?))
        })
    }
    pub fn delete_role(&self, c: &Context, id: &str) -> Result<()> {
        let dsp = s(&c.dsp, "id");
        self.platform.transaction(|| {
            let role = self.role(dsp, id)?;
            ensure(!flag(&role, "system"), "owner_role_locked", 409)?;
            self.ensure_assignable(c, &role)?;
            let used = self.platform.one("SELECT (SELECT count(*) FROM memberships WHERE role_id=?1)+(SELECT count(*) FROM invitations WHERE role_id=?1 AND used_at IS NULL AND expires_at>?2) count",params![id,now()])?.unwrap();
            ensure(n(&used, "count") == 0, "role_in_use", 409)?;
            self.platform.exec(
                "DELETE FROM invitations WHERE role_id=? AND used_at IS NULL",
                [id],
            )?;
            self.platform.exec("DELETE FROM roles WHERE id=?", [id])?;
            self.audit_ref(
                Some(s(&c.auth.user, "id")),
                Some(dsp),
                "role.deleted",
                s(&role, "name"),
                Some(s(&role, "name")),
                &[],
                Some(("role", id)),
            )
        })
    }
    pub fn legacy_role(role: &Value) -> &'static str {
        legacy(flag(role, "system"), &stored(role))
    }
}
