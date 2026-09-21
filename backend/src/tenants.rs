use super::collectors::Provider;
use super::{
    Error, Result,
    accounts::{Auth, Context},
    contracts::{
        ConnectionStatus, Dsp, DspSetupRequest, DspStatus, DspSummary, DspSummaryLegacy, Member,
        OwnerStatus,
    },
    crypto,
    db::{FromRow, Row, Store, flag, iso, now},
    ensure,
};
use rusqlite::params;
use serde_json::{Value, json};

const INSERT_DSP: &str = "INSERT INTO dsps(id,name,environment,status,timezone,permanent,created_at) \
    VALUES (?,?,?,'provisioning',?,?,?)";
// The DSPs a user may open, each with who owns it: an active owner, else the platform
// owner of the permanent DSP, else whoever holds the newest open owner invitation.
const DSPS: &str = "SELECT d.*,\
    COALESCE((SELECT r.name FROM roles r WHERE r.id=m.role_id),m.role) member_role,\
    (SELECT MIN(u.email) FROM memberships o JOIN users u ON u.id=o.user_id \
     WHERE o.dsp_id=d.id AND o.role='owner' AND u.status='active') owner_email,\
    CASE WHEN d.permanent=1 THEN \
     (SELECT MIN(email) FROM users WHERE platform_owner=1 AND status='active') END platform_email,\
    (SELECT email FROM invitations WHERE dsp_id=d.id AND role='owner' AND used_at IS NULL \
     AND expires_at>? ORDER BY expires_at DESC LIMIT 1) invite_email \
    FROM dsps d LEFT JOIN memberships m ON m.dsp_id=d.id AND m.user_id=? \
    WHERE ? OR m.user_id IS NOT NULL ORDER BY d.permanent DESC,d.name";
const MEMBERS: &str = "SELECT m.id,m.user_id,m.dsp_id,u.email,u.first_name||' '||u.last_name name,\
    COALESCE(r.name,m.role) role,r.id role_id,COALESCE(r.system,m.role='owner') owner \
    FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN roles r ON r.id=m.role_id \
    WHERE m.dsp_id=? ORDER BY u.first_name,u.last_name";
const OWNER_COUNT: &str = "SELECT count(*) FROM memberships WHERE dsp_id=? AND role='owner'";
// Only an account with no membership left, and never a platform owner's.
const REMOVABLE_ACCOUNT: &str = "SELECT first_name||' '||last_name FROM users u WHERE id=? \
    AND platform_owner=0 AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=u.id)";

struct DspListing {
    dsp: Dsp,
    legacy: DspSummaryLegacy,
}
impl FromRow for DspListing {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            dsp: Dsp::from_row(row)?,
            legacy: DspSummaryLegacy {
                member_role: row.get("member_role")?,
                owner_email: row.get("owner_email")?,
                platform_email: row.get("platform_email")?,
                invite_email: row.get("invite_email")?,
            },
        })
    }
}
/// A member as stored; who is online is added by the route.
pub struct MemberRow {
    pub id: String,
    pub user_id: String,
    pub dsp_id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub role_id: Option<String>,
    pub owner: bool,
}
impl FromRow for MemberRow {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            user_id: row.get("user_id")?,
            dsp_id: row.get("dsp_id")?,
            email: row.get("email")?,
            name: row.get("name")?,
            role: row.get("role")?,
            role_id: row.get("role_id")?,
            owner: row.get("owner")?,
        })
    }
}
impl MemberRow {
    pub fn public(self, status: super::contracts::Presence) -> Member {
        Member {
            id: self.id,
            user_id: self.user_id,
            dsp_id: self.dsp_id,
            email: self.email,
            name: self.name,
            role: self.role,
            role_id: self.role_id,
            owner: self.owner,
            status,
        }
    }
}
impl Store {
    pub fn find_dsp(&self, id: &str) -> Result<Dsp> {
        self.platform
            .one_as("SELECT * FROM dsps WHERE id=?", [id])?
            .ok_or_else(|| Error::new("dsp_not_found", 404))
    }
    /// A DSP that may collect: active, and of the environment this backend serves.
    pub fn ensure_dsp_active(&self, id: &str) -> Result<Dsp> {
        let dsp = self.find_dsp(id)?;
        ensure(self.serves(&dsp), "dsp_unavailable", 409)?;
        Ok(dsp)
    }
    pub fn serves(&self, dsp: &Dsp) -> bool {
        dsp.status == DspStatus::Active && dsp.environment == self.config.env()
    }
    /// `find_dsp` as JSON, for the integration tests written against it.
    pub fn get_dsp(&self, id: &str) -> Result<Value> {
        Ok(serde_json::to_value(self.find_dsp(id)?)?)
    }
    /// `new_dsp` as JSON, for the integration tests written against it.
    pub fn create_dsp(
        &self,
        name: &str,
        timezone: &str,
        actor: &str,
        permanent: bool,
    ) -> Result<Value> {
        Ok(serde_json::to_value(
            self.new_dsp(name, timezone, actor, permanent)?,
        )?)
    }
    pub fn new_dsp(&self, name: &str, timezone: &str, actor: &str, permanent: bool) -> Result<Dsp> {
        ensure(
            timezone.parse::<chrono_tz::Tz>().is_ok(),
            "invalid_timezone",
            400,
        )?;
        let id = crypto::id("dsp")?;
        self.platform.exec(
            INSERT_DSP,
            params![
                id,
                name,
                self.config.environment,
                timezone,
                permanent,
                iso()
            ],
        )?;
        super::roles::seed(&self.platform, &id)?;
        self.provision(&id)?;
        self.audit(Some(actor), Some(&id), "dsp.created", "")?;
        self.find_dsp(&id)
    }
    pub fn provision(&self, id: &str) -> Result<()> {
        let dsp = self.find_dsp(id)?;
        ensure(
            [DspStatus::Provisioning, DspStatus::Failed].contains(&dsp.status),
            "dsp_already_initialized",
            409,
        )?;
        let result = (|| {
            self.initialize_dsp(id)?;
            self.initialize_collectors(id)?;
            let db = self.collector(id, Provider::Paycom)?;
            db.exec(
                "INSERT OR IGNORE INTO connections(provider,updated_at) VALUES ('paycom',?)",
                [iso()],
            )?;
            // v0.0.9 reads this row on every Paycom status request. Drop it, and the
            // table, once a release without that reader has shipped.
            db.exec(
                "INSERT OR IGNORE INTO schedules(provider,timezone) VALUES ('paycom',?)",
                [&dsp.timezone],
            )?;
            self.initialize_schedules(id)?;
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
    pub fn dsps(&self, a: &Auth) -> Result<Vec<DspSummary>> {
        let platform = a.user.platform_owner;
        let rows: Vec<DspListing> = self
            .platform
            .query_as(DSPS, params![now(), a.user.id, platform])?;
        let mut result = Vec::new();
        for DspListing { dsp, legacy } in rows {
            let owner = legacy
                .owner_email
                .as_deref()
                .or(legacy.platform_email.as_deref());
            let invite = legacy.invite_email.as_deref();
            let owner_status = if owner.is_some() {
                OwnerStatus::Active
            } else if invite.is_some() {
                OwnerStatus::Invited
            } else {
                OwnerStatus::Missing
            };
            let mut summary = DspSummary {
                profile: profile_default(),
                owner_email: owner.or(invite).map(str::to_owned),
                owner_status,
                paycom: ConnectionStatus::NotConnected,
                last_collection: None,
                role: if platform {
                    Some("platform_owner".to_owned())
                } else {
                    legacy.member_role.clone()
                },
                dsp,
                legacy,
            };
            if [DspStatus::Active, DspStatus::Suspended].contains(&summary.dsp.status) {
                let id = &summary.dsp.id;
                let db = self.collector(id, Provider::Paycom)?;
                summary.profile = self.profile(id)?;
                let status: Option<(ConnectionStatus,)> =
                    db.one_as("SELECT status FROM connections WHERE provider='paycom'", [])?;
                if let Some((status,)) = status {
                    summary.paycom = status;
                }
                let collected: Option<(String,)> =
                    db.one_as("SELECT collected_at FROM publications WHERE active=1", [])?;
                summary.last_collection = collected.map(|(at,)| at);
            }
            result.push(summary);
        }
        Ok(result)
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
    pub fn set_status(&self, id: &str, status: DspStatus, actor: &str) -> Result<Dsp> {
        let dsp = self.find_dsp(id)?;
        ensure(!dsp.permanent, "permanent_dev_required", 409)?;
        ensure(
            status != DspStatus::Active || !flag(&self.profile(id)?, "removed"),
            "restore_removed_dsp_first",
            409,
        )?;
        ensure(
            [DspStatus::Active, DspStatus::Suspended].contains(&dsp.status),
            "dsp_unavailable",
            409,
        )?;
        self.platform.exec(
            "UPDATE dsps SET status=?,revision=revision+1 WHERE id=?",
            params![status, id],
        )?;
        self.audit(
            Some(actor),
            Some(id),
            if status == DspStatus::Active {
                "dsp.resumed"
            } else {
                "dsp.suspended"
            },
            "",
        )?;
        self.find_dsp(id)
    }
    pub fn update_dsp(&self, c: &Context, name: &str, timezone: &str) -> Result<Dsp> {
        self.update_dsp_details(&c.dsp.id, c.actor(), name, timezone)
    }
    fn update_dsp_details(&self, id: &str, actor: &str, name: &str, timezone: &str) -> Result<Dsp> {
        let before = self.find_dsp(id)?;
        self.platform.exec(
            "UPDATE dsps SET name=?,timezone=?,revision=revision+1 WHERE id=?",
            [name, timezone, id],
        )?;
        if before.timezone != timezone {
            self.retime_schedules(id, timezone)?;
        }
        let changes: Vec<_> = [
            ("name", before.name.as_str(), name),
            ("timezone", before.timezone.as_str(), timezone),
        ]
        .into_iter()
        .filter(|(_, before, value)| before != value)
        .map(|(field, before, value)| (field, Some(before.to_owned()), Some(value.to_owned())))
        .collect();
        self.audit_with(
            Some(actor),
            Some(id),
            "dsp.settings_updated",
            "",
            None,
            &changes,
        )?;
        self.find_dsp(id)
    }
    pub fn complete_dsp_profile(
        &self,
        id: &str,
        actor: &str,
        profile: &DspSetupRequest,
    ) -> Result<()> {
        self.update_dsp_details(id, actor, &profile.name, &profile.timezone)?;
        self.set_profile(
            id,
            json!({
                "abbreviation": profile.abbreviation,
                "stationCode": profile.station_code,
                "setupRequired": false
            }),
        )?;
        self.audit_with(
            Some(actor),
            Some(id),
            "dsp.profile_completed",
            "",
            None,
            &[
                ("station", None, Some(profile.station_code.clone())),
                ("abbreviation", None, Some(profile.abbreviation.clone())),
            ],
        )
    }
    pub fn members(&self, id: &str) -> Result<Vec<MemberRow>> {
        self.platform.query_as(MEMBERS, [id])
    }
    // The owner role is mirrored into the legacy column on every write, so it
    // stays the single count that protects a DSP from losing its last owner.
    pub fn set_role(&self, c: &Context, member: &str, role: Option<&str>) -> Result<()> {
        let dsp = c.dsp.id.as_str();
        self.platform.transaction(|| {
            let user: (String,) = self
                .platform
                .one_as(
                    "SELECT user_id FROM memberships WHERE id=? AND dsp_id=?",
                    [member, dsp],
                )?
                .ok_or_else(|| Error::new("member_not_found", 404))?;
            let user = user.0.as_str();
            let current = self
                .grant(user, dsp)?
                .ok_or_else(|| Error::new("member_not_found", 404))?;
            self.ensure_assignable(c, &self.role(dsp, &current.id)?)?;
            let next = role.map(|id| self.role(dsp, id)).transpose()?;
            if let Some(next) = &next {
                self.ensure_assignable(c, next)?;
            }
            if current.owner && !next.as_ref().is_some_and(|next| next.system) {
                ensure(
                    self.platform.count(OWNER_COUNT, [dsp])? > 1,
                    "last_owner_required",
                    409,
                )?;
            }
            if let Some(next) = &next {
                self.platform.exec(
                    "UPDATE memberships SET role=?,role_id=? WHERE id=?",
                    [next.legacy(), &next.id, member],
                )?;
            } else {
                self.platform
                    .exec("DELETE FROM memberships WHERE id=?", [member])?;
            }
            self.platform
                .exec("UPDATE dsps SET revision=revision+1 WHERE id=?", [dsp])?;
            let name: (String,) = self
                .platform
                .one_as(
                    "SELECT first_name||' '||last_name FROM users WHERE id=?",
                    [user],
                )?
                .ok_or_else(|| Error::new("member_not_found", 404))?;
            self.audit_ref(
                Some(c.actor()),
                Some(dsp),
                if next.is_some() {
                    "member.role_changed"
                } else {
                    "member.removed"
                },
                next.as_ref().map_or("", |next| &next.name),
                Some(&name.0),
                &[(
                    "role",
                    Some(self.role(dsp, &current.id)?.name),
                    next.as_ref().map(|next| next.name.clone()),
                )],
                Some(("member", user)),
            )?;
            if next.is_none() {
                self.delete_account(user, c.actor())?;
            }
            Ok(())
        })
    }
    // A removed member's account goes with their last membership, freeing the
    // email for a fresh invitation. Their name stays on the activity they left.
    fn delete_account(&self, user: &str, actor: &str) -> Result<()> {
        let removable: Option<(String,)> = self.platform.one_as(REMOVABLE_ACCOUNT, [user])?;
        let Some((name,)) = removable else {
            return Ok(());
        };
        self.platform
            .exec("DELETE FROM sessions WHERE user_id=?", [user])?;
        self.platform
            .exec("DELETE FROM resets WHERE user_id=?", [user])?;
        if actor == user {
            self.platform
                .exec("DELETE FROM invitations WHERE created_by=?", [user])?;
        } else {
            self.platform.exec(
                "UPDATE invitations SET created_by=? WHERE created_by=?",
                [actor, user],
            )?;
        }
        self.platform.exec(
            "UPDATE audit SET actor_name=?,actor_id=NULL WHERE actor_id=?",
            [name.as_str(), user],
        )?;
        self.platform.exec("DELETE FROM users WHERE id=?", [user])?;
        Ok(())
    }
}
pub fn profile_default() -> Value {
    json!({"abbreviation":"","stationCode":"","setupRequired":false,"removed":false,"supportVisible":false})
}
