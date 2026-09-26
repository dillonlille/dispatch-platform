use super::*;
impl Store {
    pub fn password_attempt(&self, email: &str, ip: &str) -> Result<()> {
        self.throttle_ip(
            "login-ip",
            ip,
            self.config.security.password_ip_attempts,
            self.config.security.password_window_seconds * 1000,
        )?;
        self.throttle(
            &format!("login:email:{}", email.to_lowercase()),
            self.config.security.password_account_attempts,
            self.config.security.password_window_seconds * 1000,
        )
    }
    pub fn throttle(&self, key: &str, max: i64, window: i64) -> Result<()> {
        self.platform
            .transaction(|| self.reserve_quota(key, max, window))
    }
    pub fn throttle_ip(&self, namespace: &str, ip: &str, max: i64, window: i64) -> Result<()> {
        self.throttle(&format!("{namespace}:{}", quota_ip(ip)), max, window)
    }
    // Called under the invitation transaction, so failed issuance releases the reservation.
    pub(super) fn reserve_quota(&self, key: &str, max: i64, window: i64) -> Result<()> {
        let namespace = key.split(':').next().unwrap_or("unknown");
        ensure(
            !namespace.is_empty()
                && namespace.len() <= 32
                && namespace
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'-'),
            "invalid_throttle_key",
            500,
        )?;
        let key = crypto::sha(key);
        self.platform
            .exec("DELETE FROM throttle WHERE reset_at<?", [now()])?;
        let row: Option<(i64,)> = self
            .platform
            .one_as("SELECT count FROM throttle WHERE key=?", [&key])?;
        ensure(row.as_ref().map_or(0, |r| r.0) < max, "rate_limited", 429)?;
        let known = row.is_some();
        if !known {
            // High-cardinality input must not fill a global table and lock out every unrelated
            // throttle. Retain frequently hit keys; evict a low-use key within the noisy
            // namespace first, then globally if legacy rows already exceed the new bound.
            if self.platform.count(
                "SELECT count(*) FROM throttle WHERE namespace=?",
                [namespace],
            )? >= 4096
            {
                self.platform.exec(
                    "DELETE FROM throttle WHERE key=(SELECT key FROM throttle WHERE namespace=? \
                     ORDER BY count ASC,reset_at ASC,key ASC LIMIT 1)",
                    [namespace],
                )?;
            }
            if self.platform.count("SELECT count(*) FROM throttle", [])? >= 32768 {
                self.platform.exec(
                    "DELETE FROM throttle WHERE key=(SELECT key FROM throttle \
                     ORDER BY count ASC,reset_at ASC,key ASC LIMIT 1)",
                    [],
                )?;
            }
        }
        self.platform.exec(
            "INSERT INTO throttle(key,count,reset_at,namespace) VALUES (?,1,?,?) \
             ON CONFLICT(key) DO UPDATE SET count=count+1,namespace=excluded.namespace",
            params![key, now() + window, namespace],
        )?;
        Ok(())
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
            Some(crate::roles::Grant {
                id: "platform_owner".to_owned(),
                name: "Platform owner".to_owned(),
                owner: true,
                permissions: crate::roles::all(),
            })
        };
        let grant = grant.ok_or_else(|| Error::new("permission_denied", 403))?;
        let features = self.features(&dsp.id)?;
        let c = Context {
            auth: a.clone(),
            dsp,
            role: grant.id,
            role_name: grant.name,
            owner: grant.owner,
            permissions: grant.permissions,
            features,
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
        let c = self.context(&a, parts[0], crate::roles::ACCESS)?;
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
                && fresh.permissions == c.permissions
                && fresh.features == c.features,
            "dsp_view_expired",
            409,
        )?;
        Ok(fresh)
    }
}

fn quota_ip(value: &str) -> String {
    match value.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(ip)) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return ip.to_string();
            }
            let [a, b, c, d, ..] = ip.segments();
            format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
        }
        Ok(ip) => ip.to_string(),
        // The request boundary normally supplies a parsed address. Keeping an invalid value
        // in one fixed bucket is safer than letting malformed variants evade the quota.
        Err(_) => "invalid".into(),
    }
}
impl crate::State {
    pub async fn login(
        self: &std::sync::Arc<Self>,
        email: String,
        password: String,
        ip: String,
        user_agent: String,
        lifetime: SessionLifetime,
    ) -> Result<String> {
        let permit = self
            .password_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("login_busy", 429))?;
        let row = self
            .run(move |db| {
                db.password_attempt(&email, &ip)?;
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
            let device = device_label(&user_agent);
            let hash = crypto::sha(&raw);
            db.platform.transaction(|| {
                db.platform
                    .exec("DELETE FROM sessions WHERE expires_at<?", [now()])?;
                db.platform.exec(
                    "INSERT INTO sessions VALUES (?,?,?,?,?)",
                    params![
                        hash,
                        row.user.id,
                        row.version,
                        created_at + lifetime.seconds() * 1000,
                        created_at
                    ],
                )?;
                db.platform.exec(
                    "INSERT INTO session_metadata(session_hash,device) VALUES (?,?)",
                    params![hash, device],
                )?;
                db.audit(Some(&row.user.id), None, "account.signed_in", "")
            })?;
            Ok(raw)
        })
        .await
    }
}

fn device_label(user_agent: &str) -> String {
    let browser = if user_agent.contains("Firefox/") {
        "Firefox"
    } else if user_agent.contains("Edg/") {
        "Edge"
    } else if user_agent.contains("Chrome/") || user_agent.contains("Chromium/") {
        "Chrome"
    } else if user_agent.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    let system = if user_agent.contains("Android") {
        "Android"
    } else if user_agent.contains("iPhone") || user_agent.contains("iPad") {
        "iOS"
    } else if user_agent.contains("Windows") {
        "Windows"
    } else if user_agent.contains("Macintosh") || user_agent.contains("Mac OS") {
        "macOS"
    } else if user_agent.contains("Linux") {
        "Linux"
    } else {
        "unknown device"
    };
    format!("{browser} on {system}")
}

#[cfg(test)]
mod device_tests {
    use super::{device_label, quota_ip};

    #[test]
    fn user_agents_become_bounded_non_identifying_device_labels() {
        assert_eq!(
            device_label("Mozilla/5.0 (Macintosh) AppleWebKit Safari/605.1"),
            "Safari on macOS"
        );
        assert_eq!(
            device_label("arbitrary private detail"),
            "Browser on unknown device"
        );
    }

    #[test]
    fn ipv6_throttles_share_their_network_prefix() {
        assert_eq!(
            quota_ip("2001:db8:12:34::1"),
            quota_ip("2001:db8:12:34:ffff::2")
        );
        assert_ne!(quota_ip("2001:db8:12:34::1"), quota_ip("2001:db8:12:35::1"));
        assert_eq!(quota_ip("::ffff:192.0.2.7"), "192.0.2.7");
        assert_eq!(quota_ip("not-an-address"), "invalid");
    }
}
