//! Accounts, authenticated contexts, sessions and invitations.
mod invitations;
mod passwords;
mod sessions;

use crate::{
    Error, Result,
    contracts::{Dsp, DspSetupRequest, DspStatus, PublicUser, UserStatus},
    crypto,
    db::{Db, FromRow, Row, Store, flag, iso, now, s},
    ensure,
    mail::templates as email,
    validate as v,
};
use passwords::same_password_user;
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
/// A used invitation still names its DSP and role, so opening its link again can point to Sign In.
const ACCEPTED_INVITATION: &str = "SELECT i.email,d.name dspName,COALESCE(r.name,i.role) role \
    FROM invitations i JOIN dsps d ON d.id=i.dsp_id LEFT JOIN roles r ON r.id=i.role_id \
    AND r.dsp_id=i.dsp_id WHERE i.hash=? AND i.used_at IS NOT NULL AND d.status='active' \
    AND d.environment=?";

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
