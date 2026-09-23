use super::*;
use crate::contracts::{AccountSession, PasskeySummary, SecurityStatus};
use webauthn_rs::prelude::*;

const FRESH: i64 = 5 * 60000;

fn webauthn(db: &Store) -> Result<Webauthn> {
    let origin =
        url::Url::parse(&db.config.origin).map_err(|_| Error::new("invalid_origin", 500))?;
    WebauthnBuilder::new(
        origin
            .host_str()
            .ok_or_else(|| Error::new("invalid_origin", 500))?,
        &origin,
    )
    .and_then(|builder| builder.rp_name("Dispatch").build())
    .map_err(|_| Error::new("passkeys_unavailable", 503))
}

impl Store {
    pub fn security_status(&self, a: &Auth) -> Result<SecurityStatus> {
        let enrolled = self.platform.count(
            "SELECT count(*) FROM passkeys WHERE user_id=?",
            [&a.user.id],
        )? > 0;
        // Second-factor protection is an individual choice, never inherited from a role.
        let required = enrolled;
        let verified: Option<(i64,)> = self.platform.one_as(
            "SELECT verified_at FROM session_security WHERE session_hash=?",
            [&a.hash],
        )?;
        let at = verified.map_or(0, |r| r.0);
        Ok(SecurityStatus {
            enrolled,
            required,
            verified: at > 0,
            recent: at > now() - self.config.security.fresh_auth_seconds * 1000,
        })
    }
    pub fn ensure_mfa(&self, a: &Auth) -> Result<()> {
        let status = self.security_status(a)?;
        ensure(
            !status.required || (status.enrolled && status.verified),
            "mfa_required",
            403,
        )
    }
    pub fn ensure_recent(&self, a: &Auth) -> Result<()> {
        self.ensure_mfa(a)?;
        let status = self.security_status(a)?;
        if status.enrolled {
            ensure(status.recent, "reauthentication_required", 403)
        } else {
            Ok(())
        }
    }
    fn ensure_recent_password(&self, a: &Auth) -> Result<()> {
        ensure(self.platform.count(
            "SELECT count(*) FROM sessions s LEFT JOIN session_security x ON x.session_hash=s.hash \
             WHERE s.hash=? AND MAX(s.created_at,COALESCE(x.password_verified_at,0))>?",
            params![a.hash, now()-self.config.security.fresh_auth_seconds * 1000],
        )? == 1, "sign_in_again", 403)
    }
    fn passkeys(&self, a: &Auth) -> Result<Vec<Passkey>> {
        self.platform
            .query_as::<(String,)>(
                "SELECT credential FROM passkeys WHERE user_id=? ORDER BY id",
                [&a.user.id],
            )?
            .into_iter()
            .map(|(credential,)| Ok(serde_json::from_str(&credential)?))
            .collect()
    }
    pub fn passkey_list(&self, a: &Auth) -> Result<Vec<PasskeySummary>> {
        self.platform.query_as(
            "SELECT id,name,created_at FROM passkeys WHERE user_id=? ORDER BY created_at",
            [&a.user.id],
        )
    }
    fn save_challenge<T: serde::Serialize>(&self, a: &Auth, kind: &str, state: &T) -> Result<()> {
        self.throttle(&format!("passkey:start:{}", a.user.id), 20, 60000)?;
        self.platform.exec(
            "DELETE FROM security_challenges WHERE expires_at<?",
            [now()],
        )?;
        self.platform.exec(
            "INSERT INTO security_challenges VALUES (?,?,?,?) ON CONFLICT(session_hash) \
             DO UPDATE SET kind=excluded.kind,state=excluded.state,expires_at=excluded.expires_at",
            params![a.hash, kind, serde_json::to_string(state)?, now() + FRESH],
        )?;
        Ok(())
    }
    // Consumed even when the response is invalid; never put this inside a rollback-on-error transaction.
    fn consume_challenge<T: serde::de::DeserializeOwned>(&self, a: &Auth, kind: &str) -> Result<T> {
        self.throttle(&format!("passkey:finish:{}", a.user.id), 20, 60000)?;
        let row: Option<(String,)> = self.platform.one_as(
            "SELECT state FROM security_challenges WHERE session_hash=? AND kind=? AND expires_at>?",
            params![a.hash, kind, now()],
        )?;
        self.platform.exec(
            "DELETE FROM security_challenges WHERE session_hash=?",
            [&a.hash],
        )?;
        let (state,) = row.ok_or_else(|| Error::new("verification_expired", 409))?;
        Ok(serde_json::from_str(&state)?)
    }
    pub fn passkey_register_start(&self, a: &Auth) -> Result<Value> {
        if self.security_status(a)?.enrolled {
            self.ensure_recent(a)?;
        } else {
            self.ensure_recent_password(a)?;
        }
        let keys = self.passkeys(a)?;
        ensure(keys.len() < 10, "passkey_limit", 409)?;
        let user = Uuid::parse_str(a.user.id.strip_prefix("usr_").unwrap_or(""))
            .map_err(|_| Error::new("invalid_account", 500))?;
        let (challenge, state) = webauthn(self)?
            .start_passkey_registration(
                user,
                &a.user.email,
                &a.user.name(),
                Some(keys.iter().map(|key| key.cred_id().clone()).collect()),
            )
            .map_err(|_| Error::new("passkey_failed", 400))?;
        self.save_challenge(a, "register", &state)?;
        Ok(serde_json::to_value(challenge)?)
    }
    pub fn passkey_register_finish(
        &self,
        a: &Auth,
        credential: Value,
        name: &str,
    ) -> Result<Vec<String>> {
        if self.security_status(a)?.enrolled {
            self.ensure_recent(a)?;
        } else {
            self.ensure_recent_password(a)?;
        }
        let state: PasskeyRegistration = self.consume_challenge(a, "register")?;
        let credential: RegisterPublicKeyCredential = serde_json::from_value(credential)?;
        let key = webauthn(self)?
            .finish_passkey_registration(&credential, &state)
            .map_err(|_| Error::new("passkey_failed", 400))?;
        let id = crypto::sha(&serde_json::to_string(key.cred_id())?);
        self.platform.transaction(|| {
            let first = !self.security_status(a)?.enrolled;
            ensure(
                self.platform
                    .count("SELECT count(*) FROM passkeys WHERE id=?", [&id])?
                    == 0,
                "passkey_exists",
                409,
            )?;
            self.platform.exec(
                "INSERT INTO passkeys VALUES (?,?,?,?,?)",
                params![id, a.user.id, serde_json::to_string(&key)?, name, now()],
            )?;
            self.verify_session(a)?;
            self.revoke_other_sessions(a)?;
            self.audit(Some(&a.user.id), None, "account.passkey_added", "")?;
            if first {
                self.create_recovery_codes(a)
            } else {
                Ok(vec![])
            }
        })
    }
    pub fn passkey_verify_start(&self, a: &Auth) -> Result<Value> {
        let (challenge, state) = webauthn(self)?
            .start_passkey_authentication(&self.passkeys(a)?)
            .map_err(|_| Error::new("passkey_failed", 400))?;
        self.save_challenge(a, "verify", &state)?;
        Ok(serde_json::to_value(challenge)?)
    }
    pub fn passkey_verify_finish(&self, a: &Auth, credential: Value) -> Result<()> {
        let state: PasskeyAuthentication = self.consume_challenge(a, "verify")?;
        let credential: PublicKeyCredential = serde_json::from_value(credential)?;
        let result = webauthn(self)?
            .finish_passkey_authentication(&credential, &state)
            .map_err(|_| Error::new("passkey_failed", 403))?;
        self.platform.transaction(|| {
            let mut matched = false;
            for mut key in self.passkeys(a)? {
                if key.update_credential(&result).is_some() {
                    let id = crypto::sha(&serde_json::to_string(key.cred_id())?);
                    self.platform.exec(
                        "UPDATE passkeys SET credential=? WHERE id=? AND user_id=?",
                        params![serde_json::to_string(&key)?, id, a.user.id],
                    )?;
                    matched = true;
                }
            }
            ensure(matched, "passkey_failed", 403)?;
            self.verify_session(a)?;
            self.audit(Some(&a.user.id), None, "account.second_factor_verified", "")
        })
    }
    fn verify_session(&self, a: &Auth) -> Result<()> {
        self.platform.exec(
            "INSERT INTO session_security(session_hash,verified_at) VALUES (?,?) \
             ON CONFLICT(session_hash) DO UPDATE SET verified_at=excluded.verified_at",
            params![a.hash, now()],
        )?;
        Ok(())
    }
    pub fn remove_passkey(&self, a: &Auth, id: &str) -> Result<()> {
        self.ensure_recent(a)?;
        self.platform.transaction(|| {
            ensure(
                self.platform.exec(
                    "DELETE FROM passkeys WHERE id=? AND user_id=?",
                    [id, &a.user.id],
                )? == 1,
                "passkey_not_found",
                404,
            )?;
            self.revoke_other_sessions(a)?;
            if !self.security_status(a)?.enrolled {
                self.platform.exec("DELETE FROM recovery_codes WHERE user_id=?", [&a.user.id])?;
                self.platform.exec(
                    "DELETE FROM security_challenges WHERE session_hash IN (SELECT hash FROM sessions WHERE user_id=?)",
                    [&a.user.id],
                )?;
                self.platform.exec("DELETE FROM session_security WHERE session_hash=?", [&a.hash])?;
            }
            self.audit(Some(&a.user.id), None, "account.passkey_removed", "")
        })
    }
    pub fn new_recovery_codes(&self, a: &Auth) -> Result<Vec<String>> {
        self.ensure_recent(a)?;
        ensure(self.security_status(a)?.enrolled, "mfa_required", 403)?;
        self.platform.transaction(|| self.create_recovery_codes(a))
    }
    fn create_recovery_codes(&self, a: &Auth) -> Result<Vec<String>> {
        self.platform
            .exec("DELETE FROM recovery_codes WHERE user_id=?", [&a.user.id])?;
        let mut codes = Vec::new();
        for _ in 0..8 {
            let code = crypto::token()?;
            self.platform.exec(
                "INSERT INTO recovery_codes VALUES (?,?)",
                params![crypto::sha(&code), a.user.id],
            )?;
            codes.push(code);
        }
        self.audit(Some(&a.user.id), None, "account.recovery_codes_created", "")?;
        Ok(codes)
    }
    pub fn use_recovery_code(&self, a: &Auth, code: &str) -> Result<()> {
        self.ensure_recent_password(a)?;
        self.throttle(&format!("recovery-code:{}", a.user.id), 5, 900000)?;
        self.platform.transaction(|| {
            ensure(
                self.platform.exec(
                    "DELETE FROM recovery_codes WHERE hash=? AND user_id=?",
                    params![crypto::sha(code), a.user.id],
                )? == 1,
                "invalid_recovery_code",
                403,
            )?;
            self.verify_session(a)?;
            self.revoke_other_sessions(a)?;
            self.audit(Some(&a.user.id), None, "account.recovery_code_used", "")
        })
    }
    pub fn account_sessions(&self, a: &Auth) -> Result<Vec<AccountSession>> {
        self.platform.query_as::<(String, i64, i64)>(
            "SELECT hash,created_at,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100",
            params![a.user.id, now()],
        )?.into_iter().map(|(hash, created_at, expires_at)| Ok(AccountSession {
            id: crypto::sign(&self.key, &format!("session-id:{hash}")), created_at, expires_at, current: hash == a.hash,
        })).collect()
    }
    pub fn revoke_session(&self, a: &Auth, id: &str) -> Result<()> {
        for (hash,) in self
            .platform
            .query_as::<(String,)>("SELECT hash FROM sessions WHERE user_id=?", [&a.user.id])?
        {
            if crypto::equal(id, &crypto::sign(&self.key, &format!("session-id:{hash}"))) {
                self.platform
                    .exec("DELETE FROM sessions WHERE hash=?", [&hash])?;
                return self.audit(Some(&a.user.id), None, "account.session_revoked", "");
            }
        }
        Err(Error::new("session_not_found", 404))
    }
    pub fn revoke_other_sessions(&self, a: &Auth) -> Result<()> {
        self.platform.exec(
            "DELETE FROM sessions WHERE user_id=? AND hash<>?",
            [&a.user.id, &a.hash],
        )?;
        Ok(())
    }
}
