use super::{
    Error, Result, crypto,
    db::{Store, flag, iso, n, now, s},
    email, ensure, validate as v,
};
use rusqlite::params;
use serde_json::{Value, json};
const INVITATION_TTL: i64 = 7 * 86400000;
#[derive(Clone)]
pub struct Auth {
    pub user: Value,
    pub hash: String,
    pub csrf: String,
    pub raw: String,
}
#[derive(Clone)]
pub struct Context {
    pub auth: Auth,
    pub dsp: Value,
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
pub fn user(row: &Value) -> Result<Value> {
    Ok(serde_json::to_value(
        super::contracts::PublicUser::from_row(row)?,
    )?)
}
impl Store {
    pub fn create_user(
        &self,
        email: &str,
        first: &str,
        last: &str,
        password: &str,
        owner: bool,
    ) -> Result<Value> {
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
        self.platform.exec("INSERT INTO users(id,email,first_name,last_name,password,platform_owner,created_at) VALUES (?,?,?,?,?,?,?)",params![id,email,first,last,encoded,owner,iso()])?;
        Ok(json!({"id":id,"email":email,"firstName":first,"lastName":last,"platformOwner":owner}))
    }
    pub fn throttle(&self, key: &str, max: i64, window: i64) -> Result<()> {
        let key = crypto::sha(key);
        self.platform.transaction(|| {
            self.platform.exec("DELETE FROM throttle WHERE reset_at<?",[now()])?;
            let row=self.platform.one("SELECT count FROM throttle WHERE key=?",[&key])?;
            ensure(row.as_ref().map_or(0,|r|n(r,"count"))<max,"rate_limited",429)?;
            ensure(row.is_some() || n(&self.platform.one("SELECT count(*) count FROM throttle",[])?.unwrap(),"count")<10000,"rate_limited",429)?;
            self.platform.exec("INSERT INTO throttle(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",params![key,now()+window])?; Ok(())
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
        let row=self.platform.one("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires_at>? AND s.user_version=u.version AND u.status='active'",params![hash,now()])?.ok_or_else(||Error::new("sign_in_required",401))?;
        Ok(Auth {
            user: user(&row)?,
            hash,
            csrf: crypto::sign(&self.key, &format!("csrf:{raw}")),
            raw: raw.into(),
        })
    }
    pub fn context(&self, a: &Auth, id: &str, permission: &str) -> Result<Context> {
        let dsp = self.get_dsp(id)?;
        let grant = if flag(&a.user, "platformOwner") {
            Some(super::roles::Grant {
                id: "platform_owner".to_owned(),
                name: "Platform owner".to_owned(),
                owner: true,
                permissions: super::roles::all(),
            })
        } else {
            self.grant(s(&a.user, "id"), id)?
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
        ensure(s(&c.dsp, "status") == "active", "dsp_unavailable", 409)?;
        ensure(
            s(&c.dsp, "environment") == self.config.environment,
            "environment_mismatch",
            403,
        )?;
        Ok(c)
    }
    pub fn view_token(&self, c: &Context) -> String {
        format!(
            "{}.{}",
            s(&c.dsp, "id"),
            crypto::sign(
                &self.key,
                &format!(
                    "view:{}:{}:{}:{}",
                    c.auth.hash,
                    s(&c.dsp, "id"),
                    n(&c.dsp, "revision"),
                    c.role
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
        let id = token.split('.').next().unwrap_or("");
        let c = self.context(a, id, super::roles::ACCESS)?;
        ensure(
            crypto::equal(&self.view_token(&c), token),
            "dsp_view_expired",
            409,
        )?;
        ensure(c.allows(permission), "permission_denied", 403)?;
        Ok(c)
    }
    pub fn revalidate(&self, c: &Context, permission: &str) -> Result<Context> {
        let a = self.authenticate(&c.auth.raw)?;
        let fresh = self.context(&a, s(&c.dsp, "id"), permission)?;
        ensure(
            fresh.dsp["revision"] == c.dsp["revision"]
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
        self.platform.exec("INSERT INTO invitations(hash,dsp_id,email,role,role_id,expires_at,created_by) VALUES (?,?,?,?,?,?,?)",params![crypto::sha(&raw),dsp,email.to_lowercase(),Self::legacy_role(&role),s(&role,"id"),now()+INVITATION_TTL,s(&a.user,"id")])?;
        self.audit(
            Some(s(&a.user, "id")),
            Some(dsp),
            "member.invited",
            s(&role, "name"),
        )?;
        Ok(raw)
    }
    pub fn invitation(&self, raw: &str) -> Result<Value> {
        ensure(raw.len() == 43, "invitation_expired", 404)?;
        let mut invitation = self.platform.one("SELECT i.email,i.dsp_id dspId,d.name dspName,r.name role,r.id roleId,r.system owner FROM invitations i JOIN dsps d ON d.id=i.dsp_id JOIN roles r ON r.id=i.role_id AND r.dsp_id=i.dsp_id WHERE i.hash=? AND i.used_at IS NULL AND i.expires_at>? AND d.status='active' AND d.environment=?",params![crypto::sha(raw),now(),self.config.environment])?.ok_or_else(||Error::new("invitation_expired",404))?;
        let owner = flag(&invitation, "owner");
        invitation.as_object_mut().unwrap().remove("owner");
        invitation["onboarding"] =
            json!(owner && flag(&self.profile(s(&invitation, "dspId"))?, "setupRequired"));
        Ok(invitation)
    }
    pub fn recovery(&self, email: &str) -> Result<()> {
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        if let Some(user) = self.platform.one(
            "SELECT * FROM users WHERE email=? AND status='active'",
            [email.trim().to_lowercase()],
        )? {
            let raw = crypto::token()?;
            self.platform.transaction(|| {
                self.platform.exec(
                    "DELETE FROM resets WHERE user_id=? OR expires_at<?",
                    params![s(&user, "id"), now()],
                )?;
                self.platform.exec(
                    "INSERT INTO resets(hash,user_id,user_version,expires_at) VALUES (?,?,?,?)",
                    params![
                        crypto::sha(&raw),
                        s(&user, "id"),
                        n(&user, "version"),
                        now() + 1800000
                    ],
                )?;
                let mail = email::reset(
                    &self.config.origin,
                    self.config.environment == "preview",
                    s(&user, "email"),
                    &format!("{}/#reset?token={raw}", self.config.origin),
                );
                self.queue_mail(
                    s(&user, "email"),
                    &mail.subject,
                    &mail.text,
                    Some(&mail.html),
                )
            })?;
        }
        Ok(())
    }
    fn reset_user(&self, raw: &str) -> Result<Value> {
        self.platform.one("SELECT u.* FROM resets r JOIN users u ON u.id=r.user_id WHERE r.hash=? AND r.used_at IS NULL AND r.expires_at>? AND r.user_version=u.version AND u.status='active'",params![crypto::sha(raw),now()])?.ok_or_else(||Error::new("reset_expired",400))
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
        let inviter = format!("{} {}", s(&a.user, "firstName"), s(&a.user, "lastName"));
        let mail = email::invitation(&email::Invitation {
            origin: &self.config.origin,
            dev: self.config.environment == "preview",
            to,
            inviter: inviter.trim(),
            dsp,
            role,
            url: &format!("{}/#invite?token={raw}", self.config.origin),
            expires_at: now() + INVITATION_TTL,
            onboarding,
        });
        self.queue_mail(to, &mail.subject, &mail.text, Some(&mail.html))
    }
    fn queue_mail(&self, to: &str, subject: &str, text: &str, html: Option<&str>) -> Result<()> {
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        let subject = if self.config.environment == "preview" {
            format!("[Dispatch Dev] {subject}")
        } else {
            subject.to_owned()
        };
        let id = crypto::id("mail")?;
        let encrypted = crypto::encrypt(
            &self.key,
            &id,
            &json!({"to":to,"subject":subject,"text":text,"html":html,"environment":self.config.environment,"origin":self.config.origin}),
        )?;
        self.platform.exec(
            "INSERT INTO outbox(id,encrypted_message,available_at,created_at) VALUES (?,?,?3,?3)",
            params![id, encrypted, now()],
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
                db.platform
                    .one("SELECT * FROM users WHERE id=?", [s(&a.user, "id")])?
                    .ok_or_else(|| Error::new("sign_in_required", 401))
            })
            .await?;
        let expected = row.clone();
        let encoded = self
            .password_work(move || {
                ensure(
                    crypto::check_password(&current, s(&expected, "password")),
                    "invalid_password",
                    403,
                )?;
                crypto::hash_password(&password)
            })
            .await?;
        self.run(move |db| {
            db.authenticate(&auth.raw)?;
            let fresh = db
                .platform
                .one("SELECT * FROM users WHERE id=?", [s(&row, "id")])?;
            ensure(
                fresh
                    .as_ref()
                    .is_some_and(|fresh| same_password_user(fresh, &row)),
                "sign_in_required",
                401,
            )?;
            db.replace_password(s(&row, "id"), &encoded, "account.password_changed")
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
            db.replace_password(s(&row, "id"), &encoded, "account.password_reset")
        })
        .await
    }
    pub async fn accept_invitation(
        self: &std::sync::Arc<Self>,
        raw: String,
        first: String,
        last: String,
        password: String,
    ) -> Result<Value> {
        let token = raw.clone();
        let (invite, existing) = self
            .read(move |db| {
                let invite = db.invitation(&token)?;
                let existing = db
                    .platform
                    .one("SELECT * FROM users WHERE email=?", [s(&invite, "email")])?;
                Ok((invite, existing))
            })
            .await?;
        let expected = existing.clone();
        let encoded = self
            .password_work(move || {
                if let Some(row) = expected {
                    ensure(
                        s(&row, "status") == "active"
                            && crypto::check_password(&password, s(&row, "password")),
                        "sign_in_with_existing_password",
                        403,
                    )?;
                    Ok(None)
                } else {
                    Ok(Some(crypto::hash_password(&password)?))
                }
            })
            .await?;
        self.run(move |db| db.platform.transaction(|| {
            let fresh_invite = db.invitation(&raw)?;
            ensure(fresh_invite == invite,"invitation_expired",404)?;
            let fresh = db.platform.one("SELECT * FROM users WHERE email=?",[s(&invite,"email")])?;
            let id = match (existing.as_ref(), fresh.as_ref()) {
                (Some(before),Some(after)) if same_password_user(before,after) => s(after,"id").to_owned(),
                (None,None) => {
                    let id = crypto::id("usr")?;
                    db.platform.exec("INSERT INTO users(id,email,first_name,last_name,password,created_at) VALUES (?,?,?,?,?,?)",params![id,s(&invite,"email"),first,last,encoded,iso()])?;
                    id
                },
                _ => return Err(Error::new("sign_in_with_existing_password",403)),
            };
            let role = db.role(s(&invite,"dspId"),s(&invite,"roleId"))?;
            db.platform.exec("INSERT INTO memberships(id,user_id,dsp_id,role,role_id) VALUES (?,?,?,?,?) ON CONFLICT(user_id,dsp_id) DO NOTHING",params![crypto::id("mem")?,id,s(&invite,"dspId"),Store::legacy_role(&role),s(&role,"id")])?;
            db.platform.exec("UPDATE invitations SET used_at=? WHERE hash=?",params![now(),crypto::sha(&raw)])?;
            db.audit(Some(&id),Some(s(&invite,"dspId")),"member.joined","")?;
            Ok(json!({"email":invite["email"],"dspId":invite["dspId"]}))
        })).await
    }
    pub async fn login(
        self: &std::sync::Arc<Self>,
        email: String,
        password: String,
        ip: String,
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
                db.platform
                    .one("SELECT * FROM users WHERE email=?", [email])
            })
            .await?;
        let value = row.clone();
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
            let encoded = if let Some(ref row) = value {
                s(row, "password")
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
            .filter(|r| valid && s(r, "status") == "active")
            .ok_or_else(|| Error::new("invalid_login", 401))?;
        self.run(move |db| {
            let current = db
                .platform
                .one(
                    "SELECT status,version FROM users WHERE id=?",
                    [s(&row, "id")],
                )?
                .ok_or_else(|| Error::new("invalid_login", 401))?;
            ensure(
                s(&current, "status") == "active" && current["version"] == row["version"],
                "invalid_login",
                401,
            )?;
            let raw = crypto::token()?;
            db.platform.transaction(|| {
                db.platform
                    .exec("DELETE FROM sessions WHERE expires_at<?", [now()])?;
                db.platform.exec(
                    "INSERT INTO sessions VALUES (?,?,?,?,?)",
                    params![
                        crypto::sha(&raw),
                        s(&row, "id"),
                        n(&row, "version"),
                        now() + 8 * 3600000,
                        now()
                    ],
                )?;
                db.audit(Some(s(&row, "id")), None, "account.signed_in", "")
            })?;
            Ok(raw)
        })
        .await
    }
}

fn same_password_user(a: &Value, b: &Value) -> bool {
    ["id", "version", "password"]
        .iter()
        .all(|key| a[key] == b[key])
        && s(a, "status") == "active"
        && s(b, "status") == "active"
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};
    #[tokio::test]
    async fn password_work_is_bounded_without_holding_database_slots() {
        let root = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = crate::core::config::Config::load().unwrap();
        config.root = root.path().into();
        let state = crate::core::State::new(config).unwrap();
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
