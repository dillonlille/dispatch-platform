use super::collectors::Provider;
use super::{
    Error, Result,
    accounts::{Auth, Context},
    crypto,
    db::{Store, boolean, flag, iso, n, now, s},
    ensure,
};
use rusqlite::params;
use serde_json::{Value, json};
fn dsp(mut row: Value) -> Value {
    boolean(&mut row, &["permanent"]);
    let created = row
        .as_object_mut()
        .unwrap()
        .remove("created_at")
        .unwrap_or(Value::Null);
    row["createdAt"] = created;
    row
}
impl Store {
    pub fn get_dsp(&self, id: &str) -> Result<Value> {
        self.platform
            .one("SELECT * FROM dsps WHERE id=?", [id])?
            .map(dsp)
            .ok_or_else(|| Error::new("dsp_not_found", 404))
    }
    pub fn create_dsp(
        &self,
        name: &str,
        timezone: &str,
        actor: &str,
        permanent: bool,
    ) -> Result<Value> {
        ensure(
            timezone.parse::<chrono_tz::Tz>().is_ok(),
            "invalid_timezone",
            400,
        )?;
        let id = crypto::id("dsp")?;
        self.platform.exec("INSERT INTO dsps(id,name,environment,status,timezone,permanent,created_at) VALUES (?,?,?,'provisioning',?,?,?)",params![id,name,self.config.environment,timezone,permanent,iso()])?;
        self.provision(&id)?;
        self.audit(Some(actor), Some(&id), "dsp.created", "")?;
        self.get_dsp(&id)
    }
    pub fn provision(&self, id: &str) -> Result<()> {
        let dsp = self.get_dsp(id)?;
        ensure(
            ["provisioning", "failed"].contains(&s(&dsp, "status")),
            "dsp_already_initialized",
            409,
        )?;
        let result = (|| {
            self.initialize_dsp(id)?;
            if super::collectors::MIGRATE_ON_START {
                self.migrate_collector_storage(id)?;
            }
            let db = self.collector(id, Provider::Paycom)?;
            db.exec(
                "INSERT OR IGNORE INTO connections(provider,updated_at) VALUES ('paycom',?)",
                [iso()],
            )?;
            db.exec(
                "INSERT OR IGNORE INTO schedules(provider,timezone) VALUES ('paycom',?)",
                [s(&dsp, "timezone")],
            )?;
            self.platform
                .exec("UPDATE dsps SET status='active' WHERE id=?", [id])?;
            Ok(())
        })();
        if result.is_err() {
            self.platform
                .exec("UPDATE dsps SET status='failed' WHERE id=?", [id])?;
        }
        result
    }
    pub fn dsps(&self, a: &Auth) -> Result<Value> {
        let rows = if flag(&a.user, "platformOwner") {
            self.platform
                .all("SELECT * FROM dsps ORDER BY permanent DESC,name", [])?
        } else {
            self.platform.all("SELECT d.* FROM dsps d JOIN memberships m ON m.dsp_id=d.id WHERE m.user_id=? ORDER BY d.permanent DESC,d.name",[s(&a.user,"id")])?
        };
        let mut result = Vec::new();
        for row in rows {
            let mut value = dsp(row);
            let id = s(&value, "id").to_owned();
            let mut owner=self.platform.one("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.dsp_id=? AND m.role='owner' AND u.status='active' ORDER BY u.email LIMIT 1",[&id])?;
            if owner.is_none() && flag(&value, "permanent") {
                owner=self.platform.one("SELECT email FROM users WHERE platform_owner=1 AND status='active' ORDER BY email LIMIT 1",[])?;
            }
            let invite=self.platform.one("SELECT email FROM invitations WHERE dsp_id=? AND role='owner' AND used_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1",params![id,now()])?;
            value["ownerStatus"] = json!(if owner.is_some() {
                "active"
            } else if invite.is_some() {
                "invited"
            } else {
                "missing"
            });
            value["ownerEmail"] = owner
                .or(invite)
                .map(|r| r["email"].clone())
                .unwrap_or(Value::Null);
            value["role"] = if flag(&a.user, "platformOwner") {
                json!("platform_owner")
            } else {
                self.platform
                    .one(
                        "SELECT role FROM memberships WHERE user_id=? AND dsp_id=?",
                        [s(&a.user, "id"), &id],
                    )?
                    .map(|r| r["role"].clone())
                    .unwrap_or(Value::Null)
            };
            value["paycom"] = json!("not_connected");
            value["lastCollection"] = Value::Null;
            value["profile"] = profile_default();
            if ["active", "suspended"].contains(&s(&value, "status")) {
                let db = self.collector(&id, Provider::Paycom)?;
                value["profile"] = self.profile(&id)?;
                if let Some(r) =
                    db.one("SELECT status FROM connections WHERE provider='paycom'", [])?
                {
                    value["paycom"] = r["status"].clone();
                }
                if let Some(r) =
                    db.one("SELECT collected_at FROM publications WHERE active=1", [])?
                {
                    value["lastCollection"] = r["collected_at"].clone();
                }
            }
            result.push(value);
        }
        Ok(json!(result))
    }
    pub fn profile(&self, id: &str) -> Result<Value> {
        let mut out = profile_default();
        let stored = self.dsp(id)?.setting("dsp.profile", json!({}))?;
        for (k, v) in stored
            .as_object()
            .ok_or_else(|| Error::new("invalid_profile", 500))?
        {
            out[k] = v.clone();
        }
        Ok(out)
    }
    pub fn set_profile(&self, id: &str, changes: Value) -> Result<Value> {
        let mut profile = self.profile(id)?;
        for (k, v) in changes
            .as_object()
            .ok_or_else(|| Error::new("invalid_input", 400))?
        {
            profile[k] = v.clone();
        }
        self.dsp(id)?.set("dsp.profile", &profile)?;
        Ok(profile)
    }
    pub fn set_status(&self, id: &str, status: &str, actor: &str) -> Result<Value> {
        let dsp = self.get_dsp(id)?;
        ensure(!flag(&dsp, "permanent"), "permanent_dev_required", 409)?;
        ensure(
            status != "active" || !flag(&self.profile(id)?, "removed"),
            "restore_removed_dsp_first",
            409,
        )?;
        ensure(
            ["active", "suspended"].contains(&s(&dsp, "status")),
            "dsp_unavailable",
            409,
        )?;
        self.platform.exec(
            "UPDATE dsps SET status=?,revision=revision+1 WHERE id=?",
            [status, id],
        )?;
        self.audit(
            Some(actor),
            Some(id),
            if status == "active" {
                "dsp.resumed"
            } else {
                "dsp.suspended"
            },
            "",
        )?;
        self.get_dsp(id)
    }
    pub fn update_dsp(&self, c: &Context, name: &str, timezone: &str) -> Result<Value> {
        let id = s(&c.dsp, "id");
        self.platform.exec(
            "UPDATE dsps SET name=?,timezone=?,revision=revision+1 WHERE id=?",
            [name, timezone, id],
        )?;
        self.collector(id, Provider::Paycom)?
            .exec("UPDATE schedules SET timezone=?,next_run=NULL", [timezone])?;
        self.audit(
            Some(s(&c.auth.user, "id")),
            Some(id),
            "dsp.settings_updated",
            "",
        )?;
        self.get_dsp(id)
    }
    pub fn members(&self, id: &str) -> Result<Value> {
        Ok(json!(self.platform.all("SELECT m.id,m.user_id userId,m.dsp_id dspId,u.email,u.first_name||' '||u.last_name name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.dsp_id=? ORDER BY u.first_name,u.last_name",[id])?))
    }
    pub fn set_role(&self, c: &Context, member: &str, role: Option<&str>) -> Result<()> {
        self.platform.transaction(|| {
            let row=self.platform.one("SELECT * FROM memberships WHERE id=? AND dsp_id=?",[member,s(&c.dsp,"id")])?.ok_or_else(||Error::new("member_not_found",404))?;
            if s(&row,"role")=="owner" && role!=Some("owner") { ensure(n(&self.platform.one("SELECT count(*) count FROM memberships WHERE dsp_id=? AND role='owner'",[s(&c.dsp,"id")])?.unwrap(),"count")>1,"last_owner_required",409)?; }
            if let Some(role)=role {self.platform.exec("UPDATE memberships SET role=? WHERE id=?",[role,member])?;} else {self.platform.exec("DELETE FROM memberships WHERE id=?",[member])?;}
            self.platform.exec("UPDATE dsps SET revision=revision+1 WHERE id=?",[s(&c.dsp,"id")])?;
            self.audit(Some(s(&c.auth.user,"id")),Some(s(&c.dsp,"id")),if role.is_some(){"member.role_changed"}else{"member.removed"},role.unwrap_or(""))
        })
    }
}
pub fn profile_default() -> Value {
    json!({"abbreviation":"","stationCode":"","setupRequired":false,"removed":false})
}
