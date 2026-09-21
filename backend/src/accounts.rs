use super::{
    Error, Result,
    contracts::{Dsp, DspSetupRequest, DspStatus, PublicUser, UserStatus},
    crypto,
    db::{Db, FromRow, Row, Store, flag, iso, now, s},
    ensure,
    mail::templates as email,
    validate as v,
};
use rusqlite::params;
use serde_json::{Value, json};
/// One fixed lifetime drives both the server deadline and the browser cookie.
#[derive(Clone, Copy)]
pub enum SessionLifetime {
    Standard,
    Remembered,
}
impl SessionLifetime {
    pub fn seconds(self) -> i64 {
        match self {
            Self::Standard => 8 * 60 * 60,
            Self::Remembered => 3 * 24 * 60 * 60,
        }
    }
}

const INVITATION_TTL: i64 = 7 * 86400000;
const SESSION_USER: &str = "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id \
    WHERE s.hash=? AND s.expires_at>? AND s.user_version=u.version AND u.status='active'";
const RESET_USER: &str = "SELECT u.* FROM resets r JOIN users u ON u.id=r.user_id \
    WHERE r.hash=? AND r.used_at IS NULL AND r.expires_at>? AND r.user_version=u.version \
    AND u.status='active'";
const INVITER: &str = "SELECT u.first_name||' '||u.last_name name,u.platform_owner \
    FROM invitations i JOIN users u ON u.id=i.created_by WHERE i.hash=?";
const INVITATION: &str = "SELECT i.email,i.dsp_id dspId,d.name dspName,d.timezone,r.name role,r.id roleId,\
    r.system owner FROM invitations i JOIN dsps d ON d.id=i.dsp_id \
    JOIN roles r ON r.id=i.role_id AND r.dsp_id=i.dsp_id WHERE i.hash=? AND i.used_at IS NULL \
    AND i.expires_at>? AND d.status='active' AND d.environment=?";

/// What a queued message is for. Diagnostics joins it back to the invitation or account.
enum MailContext<'a> {
    Invitation { hash: &'a str },
    Reset { user: &'a str },
}

/// A row of `users`, with the password hash: it never leaves the backend.
#[derive(Clone)]
pub struct UserRow {
    pub user: PublicUser,
    pub password: String,
    pub status: UserStatus,
    pub version: i64,
}
impl FromRow for UserRow {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            user: PublicUser::from_row(row)?,
            password: row.get("password")?,
            status: row.get("status")?,
            version: row.get("version")?,
        })
    }
}
impl UserRow {
    fn active(&self) -> bool {
        self.status == UserStatus::Active
    }
    fn find(db: &Db, column: &str, value: &str) -> Result<Option<Self>> {
        match column {
            "id" => db.one_as("SELECT * FROM users WHERE id=?", [value]),
            _ => db.one_as("SELECT * FROM users WHERE email=?", [value]),
        }
    }
}
#[derive(Clone)]
pub struct Auth {
    pub user: PublicUser,
    pub hash: String,
    pub csrf: String,
    pub raw: String,
    // The DSP role a platform owner chose to look through instead of their
    // own owner access. Members never carry one.
    pub preview: Option<String>,
}
#[derive(Clone)]
pub struct Context {
    pub auth: Auth,
    pub dsp: Dsp,
    pub role: String,
    pub role_name: String,
    pub owner: bool,
    pub permissions: Vec<String>,
}
impl Context {
    pub fn can(&self, permission: &str) -> bool {
        self.owner || self.permissions.iter().any(|p| p == permission)
    }
    // Alternatives are separated by `|`; any one of them grants the request.
    pub fn allows(&self, permission: &str) -> bool {
        permission
            .split('|')
            .any(|wanted| wanted == super::roles::ACCESS || self.can(wanted))
    }
}
impl Context {
    /// The member who is acting, for the audit log.
    pub fn actor(&self) -> &str {
        &self.auth.user.id
    }
    /// Records what the member did in this DSP.
    pub fn audit(&self, db: &Store, action: &str, detail: &str) -> Result<()> {
        db.audit(Some(self.actor()), Some(&self.dsp.id), action, detail)
    }
}
impl Store {
    pub fn create_user(
        &self,
        email: &str,
        first: &str,
        last: &str,
        password: &str,
        owner: bool,
    ) -> Result<PublicUser> {
        let value = json!({"email":email,"firstName":first,"lastName":last});
        let email = v::email(&value, "email")?;
        let first = v::name(&value, "firstName", 100)?;
        let last = v::name(&value, "lastName", 100)?;
        let encoded = crypto::hash_password(password)?;
        ensure(
            self.platform
                .one("SELECT id FROM users WHERE email=?", [&email])?
                .is_none(),
            "email_already_registered",
            409,
        )?;
        let id = crypto::id("usr")?;
        self.platform.exec(
            "INSERT INTO users(id,email,first_name,last_name,password,platform_owner,created_at) \
             VALUES (?,?,?,?,?,?,?)",
            params![id, email, first, last, encoded, owner, iso()],
        )?;
        Ok(PublicUser {
            id,
            email,
            first_name: first,
            last_name: last,
            platform_owner: owner,
        })
    }
    pub fn throttle(&self, key: &str, max: i64, window: i64) -> Result<()> {
        let key = crypto::sha(key);
        self.platform.transaction(|| {
            self.platform
                .exec("DELETE FROM throttle WHERE reset_at<?", [now()])?;
            let row: Option<(i64,)> = self
                .platform
                .one_as("SELECT count FROM throttle WHERE key=?", [&key])?;
            ensure(row.as_ref().map_or(0, |r| r.0) < max, "rate_limited", 429)?;
            let known = row.is_some();
            ensure(
                known || self.platform.count("SELECT count(*) FROM throttle", [])? < 10000,
                "rate_limited",
                429,
            )?;
            self.platform.exec(
                "INSERT INTO throttle(key,count,reset_at) VALUES (?,1,?) \
                 ON CONFLICT(key) DO UPDATE SET count=count+1",
                params![key, now() + window],
            )?;
            Ok(())
        })
    }
    pub fn authenticate(&self, raw: &str) -> Result<Auth> {
        ensure(
            raw.len() == 43
                && raw
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "sign_in_required",
            401,
        )?;
        let hash = crypto::sha(raw);
        let user: PublicUser = self
            .platform
            .one_as(SESSION_USER, params![hash, now()])?
            .ok_or_else(|| Error::new("sign_in_required", 401))?;
        Ok(Auth {
            user,
            hash,
            csrf: crypto::sign(&self.key, &format!("csrf:{raw}")),
            raw: raw.into(),
            preview: None,
        })
    }
    pub fn context(&self, a: &Auth, id: &str, permission: &str) -> Result<Context> {
        let dsp = self.find_dsp(id)?;
        let grant = if !a.user.platform_owner {
            self.grant(&a.user.id, id)?
        } else if let Some(role) = &a.preview {
            // A previewed role that was deleted reads as a stale view, so the
            // dashboard reopens the DSP rather than showing a denial.
            let row = self.find_role(id, role)?;
            Some(
                row.ok_or_else(|| Error::new("dsp_view_expired", 409))?
                    .into(),
            )
        } else {
            Some(super::roles::Grant {
                id: "platform_owner".to_owned(),
                name: "Platform owner".to_owned(),
                owner: true,
                permissions: super::roles::all(),
            })
        };
        let grant = grant.ok_or_else(|| Error::new("permission_denied", 403))?;
        let c = Context {
            auth: a.clone(),
            dsp,
            role: grant.id,
            role_name: grant.name,
            owner: grant.owner,
            permissions: grant.permissions,
        };
        ensure(c.allows(permission), "permission_denied", 403)?;
        ensure(c.dsp.status == DspStatus::Active, "dsp_unavailable", 409)?;
        ensure(
            c.dsp.environment == self.config.env(),
            "environment_mismatch",
            403,
        )?;
        Ok(c)
    }
    // A previewed role rides in the token so every request rebuilds the same
    // access; the signature covers it, so it cannot be swapped for another.
    pub fn view_token(&self, c: &Context) -> String {
        format!(
            "{}.{}{}",
            c.dsp.id,
            c.auth
                .preview
                .as_ref()
                .map_or_else(String::new, |role| format!("{role}.")),
            crypto::sign(
                &self.key,
                &format!(
                    "view:{}:{}:{}:{}",
                    c.auth.hash, c.dsp.id, c.dsp.revision, c.role
                )
            )
        )
    }
    pub fn from_view(&self, a: &Auth, token: &str, permission: &str) -> Result<Context> {
        ensure(
            !token.is_empty() && token.len() < 200,
            "dsp_view_required",
            403,
        )?;
        // A stale view is reported before a missing permission so a member whose
        // role just changed reopens the DSP instead of seeing a denial.
        let parts: Vec<_> = token.split('.').collect();
        let a = Auth {
            preview: (parts.len() == 3).then(|| parts[1].to_owned()),
            ..a.clone()
        };
        let c = self.context(&a, parts[0], super::roles::ACCESS)?;
        ensure(
            crypto::equal(&self.view_token(&c), token),
            "dsp_view_expired",
            409,
        )?;
        ensure(c.allows(permission), "permission_denied", 403)?;
        Ok(c)
    }
    pub fn revalidate(&self, c: &Context, permission: &str) -> Result<Context> {
        let a = Auth {
            preview: c.auth.preview.clone(),
            ..self.authenticate(&c.auth.raw)?
        };
        let fresh = self.context(&a, &c.dsp.id, permission)?;
        ensure(
            fresh.dsp.revision == c.dsp.revision
                && fresh.role == c.role
                && fresh.permissions == c.permissions,
            "dsp_view_expired",
            409,
        )?;
        Ok(fresh)
    }
    fn replace_password(&self, id: &str, encoded: &str, action: &str) -> Result<()> {
        self.platform.transaction(|| {
            self.platform.exec(
                "UPDATE users SET password=?,version=version+1 WHERE id=?",
                [encoded, id],
            )?;
            self.platform
                .exec("DELETE FROM sessions WHERE user_id=?", [id])?;
            self.platform
                .exec("DELETE FROM resets WHERE user_id=?", [id])?;
            self.audit(Some(id), None, action, "")
        })
    }
    pub fn invite(&self, a: &Auth, dsp: &str, email: &str, role: &str) -> Result<String> {
        let c = self.context(a, dsp, "members.invite")?;
        let role = self.role(dsp, role)?;
        self.ensure_assignable(&c, &role)?;
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        let raw = crypto::token()?;
        self.platform.exec(
            "INSERT INTO invitations(hash,dsp_id,email,role,role_id,expires_at,created_by) \
             VALUES (?,?,?,?,?,?,?)",
            params![
                crypto::sha(&raw),
                dsp,
                email.to_lowercase(),
                role.legacy(),
                role.id,
                now() + INVITATION_TTL,
                a.user.id
            ],
        )?;
        self.audit_with(
            Some(&a.user.id),
            Some(dsp),
            "member.invited",
            &role.name,
            Some(&email.to_lowercase()),
            &[],
        )?;
        Ok(raw)
    }
    pub fn invitation(&self, raw: &str) -> Result<Value> {
        ensure(raw.len() == 43, "invitation_expired", 404)?;
        let mut invitation = self
            .platform
            .one(
                INVITATION,
                params![crypto::sha(raw), now(), self.config.environment],
            )?
            .ok_or_else(|| Error::new("invitation_expired", 404))?;
        let owner = flag(&invitation, "owner");
        invitation.as_object_mut().unwrap().remove("owner");
        let profile = self.profile(s(&invitation, "dspId"))?;
        invitation["onboarding"] = json!(owner && flag(&profile, "setupRequired"));
        invitation["stationCode"] = profile["stationCode"].clone();
        Ok(invitation)
    }
    pub fn recovery(&self, email: &str) -> Result<()> {
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        let found = UserRow::find(&self.platform, "email", &email.trim().to_lowercase())?;
        if let Some(UserRow { user, version, .. }) = found.filter(UserRow::active) {
            let raw = crypto::token()?;
            self.platform.transaction(|| {
                self.platform.exec(
                    "DELETE FROM resets WHERE user_id=? OR expires_at<?",
                    params![user.id, now()],
                )?;
                self.platform.exec(
                    "INSERT INTO resets(hash,user_id,user_version,expires_at) VALUES (?,?,?,?)",
                    params![crypto::sha(&raw), user.id, version, now() + 1800000],
                )?;
                let mail = email::reset(
                    &self.config.origin,
                    self.config.env().is_preview(),
                    &user.email,
                    &format!("{}/#reset?token={raw}", self.config.origin),
                );
                self.queue_mail(&user.email, &mail, MailContext::Reset { user: &user.id })
            })?;
        }
        Ok(())
    }
    fn reset_user(&self, raw: &str) -> Result<UserRow> {
        self.platform
            .one_as(RESET_USER, params![crypto::sha(raw), now()])?
            .ok_or_else(|| Error::new("reset_expired", 400))
    }
    pub fn invitation_mail(
        &self,
        a: &Auth,
        to: &str,
        dsp: &str,
        role: &str,
        raw: &str,
        onboarding: bool,
    ) -> Result<()> {
        let inviter = a.user.name();
        let mail = email::invitation(&email::Invitation {
            origin: &self.config.origin,
            dev: self.config.env().is_preview(),
            to,
            inviter: inviter.trim(),
            dsp,
            role,
            url: &format!("{}/#invite?token={raw}", self.config.origin),
            expires_at: now() + INVITATION_TTL,
            onboarding,
        });
        self.queue_mail(
            to,
            &mail,
            MailContext::Invitation {
                hash: &crypto::sha(raw),
            },
        )
    }
    fn queue_mail(&self, to: &str, mail: &email::Message, context: MailContext) -> Result<()> {
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        let (text, html) = (&mail.text, Some(&mail.html));
        let subject = if self.config.env().is_preview() {
            format!("[Dispatch Dev] {}", mail.subject)
        } else {
            mail.subject.clone()
        };
        let id = crypto::id("mail")?;
        let encrypted = crypto::encrypt(
            &self.key,
            &id,
            &json!({"to":to,"subject":subject,"text":text,"html":html,"environment":self.config.environment,"origin":self.config.origin}),
        )?;
        let (kind, invitation, user) = match context {
            MailContext::Invitation { hash } => ("invitation", Some(hash), None),
            MailContext::Reset { user } => ("reset", None, Some(user)),
        };
        self.platform.exec(
            "INSERT INTO outbox(id,encrypted_message,available_at,created_at,kind,\
             invitation_hash,user_id) VALUES (?,?,?3,?3,?,?,?)",
            params![id, encrypted, now(), kind, invitation, user],
        )?;
        Ok(())
    }
}
impl super::State {
    async fn password_work<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .password_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("login_busy", 429))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        })
        .await
        .map_err(|_| Error::new("password_operation_failed", 500))?
    }
    pub async fn change_password(
        self: &std::sync::Arc<Self>,
        auth: Auth,
        current: String,
        password: String,
    ) -> Result<()> {
        let a = auth.clone();
        let row = self
            .read(move |db| {
                let a = db.authenticate(&a.raw)?;
                UserRow::find(&db.platform, "id", &a.user.id)?
                    .ok_or_else(|| Error::new("sign_in_required", 401))
            })
            .await?;
        let expected = row.clone();
        let encoded = self
            .password_work(move || {
                ensure(
                    crypto::check_password(&current, &expected.password),
                    "invalid_password",
                    403,
                )?;
                crypto::hash_password(&password)
            })
            .await?;
        self.run(move |db| {
            db.authenticate(&auth.raw)?;
            let fresh = UserRow::find(&db.platform, "id", &row.user.id)?;
            ensure(
                fresh
                    .as_ref()
                    .is_some_and(|fresh| same_password_user(fresh, &row)),
                "sign_in_required",
                401,
            )?;
            db.replace_password(&row.user.id, &encoded, "account.password_changed")
        })
        .await
    }
    pub async fn reset_password(
        self: &std::sync::Arc<Self>,
        raw: String,
        password: String,
    ) -> Result<()> {
        let token = raw.clone();
        let row = self.read(move |db| db.reset_user(&token)).await?;
        let encoded = self
            .password_work(move || crypto::hash_password(&password))
            .await?;
        self.run(move |db| {
            let fresh = db.reset_user(&raw)?;
            ensure(same_password_user(&fresh, &row), "reset_expired", 400)?;
            db.replace_password(&row.user.id, &encoded, "account.password_reset")
        })
        .await
    }
    pub async fn accept_invitation(
        self: &std::sync::Arc<Self>,
        raw: String,
        first: String,
        last: String,
        password: String,
        dsp_profile: Option<DspSetupRequest>,
    ) -> Result<Value> {
        let token = raw.clone();
        let (invite, existing) = self
            .read(move |db| {
                let invite = db.invitation(&token)?;
                let existing = UserRow::find(&db.platform, "email", s(&invite, "email"))?;
                Ok((invite, existing))
            })
            .await?;
        ensure(
            dsp_profile.is_none() || flag(&invite, "onboarding"),
            "permission_denied",
            403,
        )?;
        let expected = existing.clone();
        let encoded = self
            .password_work(move || {
                if let Some(row) = expected {
                    ensure(
                        row.active() && crypto::check_password(&password, &row.password),
                        "sign_in_with_existing_password",
                        403,
                    )?;
                    Ok(None)
                } else {
                    Ok(Some(crypto::hash_password(&password)?))
                }
            })
            .await?;
        self.run(move |db| {
            db.platform.transaction(|| {
                let fresh_invite = db.invitation(&raw)?;
                ensure(fresh_invite == invite, "invitation_expired", 404)?;
                let (email, dsp) = (s(&invite, "email"), s(&invite, "dspId"));
                let fresh = UserRow::find(&db.platform, "email", email)?;
                let id = match (existing.as_ref(), fresh.as_ref()) {
                    (Some(before), Some(after)) if same_password_user(before, after) => {
                        after.user.id.clone()
                    }
                    (None, None) => {
                        let id = crypto::id("usr")?;
                        db.platform.exec(
                            "INSERT INTO users(id,email,first_name,last_name,password,created_at) \
                             VALUES (?,?,?,?,?,?)",
                            params![id, email, first, last, encoded, iso()],
                        )?;
                        id
                    }
                    _ => return Err(Error::new("sign_in_with_existing_password", 403)),
                };
                let role = db.role(dsp, s(&invite, "roleId"))?;
                db.platform.exec(
                    "INSERT INTO memberships(id,user_id,dsp_id,role,role_id) VALUES (?,?,?,?,?) \
                     ON CONFLICT(user_id,dsp_id) DO NOTHING",
                    params![crypto::id("mem")?, id, dsp, role.legacy(), role.id],
                )?;
                db.platform.exec(
                    "UPDATE invitations SET used_at=? WHERE hash=?",
                    params![now(), crypto::sha(&raw)],
                )?;
                // A platform owner's name never reaches a DSP's log.
                let inviter = db.platform.one(INVITER, [crypto::sha(&raw)])?;
                let invited_by = inviter.and_then(|u| {
                    if !flag(&u, "platform_owner") {
                        Some(s(&u, "name").to_owned())
                    } else if db.support_visible(dsp) {
                        Some("Platform support".to_owned())
                    } else {
                        None
                    }
                });
                let name = format!("{first} {last}");
                let changes: Vec<_> = invited_by
                    .map(|name| ("invitedBy", None, Some(name)))
                    .into_iter()
                    .collect();
                db.audit_ref(
                    Some(&id),
                    Some(dsp),
                    "member.joined",
                    &role.name,
                    Some(&name),
                    &changes,
                    Some(("member", &id)),
                )?;
                if let Some(profile) = &dsp_profile {
                    db.complete_dsp_profile(dsp, &id, profile)?;
                }
                Ok(json!({"email":invite["email"],"dspId":invite["dspId"]}))
            })
        })
        .await
    }
    pub async fn login(
        self: &std::sync::Arc<Self>,
        email: String,
        password: String,
        ip: String,
        lifetime: SessionLifetime,
    ) -> Result<String> {
        let permit = self
            .password_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("login_busy", 429))?;
        let row = self
            .run(move |db| {
                db.throttle(&format!("login:ip:{ip}"), 30, 900000)?;
                db.throttle(&format!("login:email:{email}"), 10, 900000)?;
                UserRow::find(&db.platform, "email", &email)
            })
            .await?;
        let value = row.clone();
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
            let encoded = if let Some(ref row) = value {
                &row.password
            } else {
                DUMMY.get_or_init(|| {
                    crypto::hash_password("a-long-dummy-password-for-timing")
                        .expect("password hashing")
                })
            };
            crypto::check_password(&password, encoded)
        })
        .await
        .map_err(|_| Error::new("login_failed", 500))?;
        let row = row
            .filter(|r| valid && r.active())
            .ok_or_else(|| Error::new("invalid_login", 401))?;
        self.run(move |db| {
            let current = UserRow::find(&db.platform, "id", &row.user.id)?
                .ok_or_else(|| Error::new("invalid_login", 401))?;
            ensure(
                current.active() && current.version == row.version,
                "invalid_login",
                401,
            )?;
            let raw = crypto::token()?;
            let created_at = now();
            db.platform.transaction(|| {
                db.platform
                    .exec("DELETE FROM sessions WHERE expires_at<?", [now()])?;
                db.platform.exec(
                    "INSERT INTO sessions VALUES (?,?,?,?,?)",
                    params![
                        crypto::sha(&raw),
                        row.user.id,
                        row.version,
                        created_at + lifetime.seconds() * 1000,
                        created_at
                    ],
                )?;
                db.audit(Some(&row.user.id), None, "account.signed_in", "")
            })?;
            Ok(raw)
        })
        .await
    }
}

fn same_password_user(a: &UserRow, b: &UserRow) -> bool {
    a.user.id == b.user.id
        && a.version == b.version
        && a.password == b.password
        && a.active()
        && b.active()
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};
    #[tokio::test]
    async fn password_work_is_bounded_without_holding_database_slots() {
        let root = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = crate::config::Config::load().unwrap();
        config.root = root.path().into();
        let state = crate::State::new(config).unwrap();
        let mut workers = Vec::new();
        let mut release = Vec::new();
        for _ in 0..2 {
            let (began, started) = tokio::sync::oneshot::channel();
            let (send, wait) = std::sync::mpsc::channel();
            release.push(send);
            let state = Arc::clone(&state);
            workers.push(tokio::spawn(async move {
                state
                    .password_work(move || {
                        let _ = began.send(());
                        let _ = wait.recv();
                        Ok(())
                    })
                    .await
            }));
            started.await.unwrap();
        }
        let busy = state.password_work(|| Ok(())).await;
        let read = tokio::time::timeout(
            Duration::from_secs(2),
            state.read(|db| db.platform.one("SELECT 1 ready", [])),
        )
        .await;
        for send in release {
            send.send(()).unwrap();
        }
        for worker in workers {
            worker.await.unwrap().unwrap();
        }
        assert_eq!(busy.unwrap_err().code, "login_busy");
        assert_eq!(read.unwrap().unwrap().unwrap()["ready"], 1);
        assert_eq!(state.password_slots.available_permits(), 2);
    }
}
