use super::*;
use crate::contracts::{AccountSession, AuthenticatorSetup, PasskeySummary, SecurityStatus};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use hmac::{Hmac, Mac, digest::KeyInit};
use qrcode::{QrCode, render::svg};
use sha1::Sha1;
use webauthn_rs::prelude::*;

const CHALLENGE_TTL: i64 = 5 * 60000;

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

fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut output = String::new();
    let (mut buffer, mut bits) = (0u32, 0u8);
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
        // Keep only the unconsumed tail so discarded high bits cannot overflow
        // the fixed-width buffer on normal 20-byte authenticator secrets.
        buffer &= (1u32 << bits) - 1;
    }
    if bits > 0 {
        output.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    output
}

fn decode_base32(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u8);
    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | u32::from(digit);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
        buffer &= (1u32 << bits) - 1;
    }
    ((bits == 0 || buffer == 0) && !output.is_empty()).then_some(output)
}

fn totp(secret: &[u8], counter: u64) -> String {
    let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(secret).expect("HMAC accepts TOTP keys");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let value = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    format!("{:06}", value % 1_000_000)
}

fn matching_totp(secret: &[u8], code: &str, time: i64) -> Option<i64> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let current = (time / 30000).max(1) as u64;
    (current.saturating_sub(1)..=current + 1)
        .find(|counter| crypto::equal(&totp(secret, *counter), code))
        .map(|counter| counter as i64)
}

impl Store {
    fn factor_counts(&self, a: &Auth) -> Result<(i64, bool)> {
        Ok((
            self.platform.count(
                "SELECT count(*) FROM account_passkeys WHERE user_id=?",
                [&a.user.id],
            )?,
            self.platform.count(
                "SELECT count(*) FROM authenticator_apps WHERE user_id=?",
                [&a.user.id],
            )? > 0,
        ))
    }

    pub fn security_status(&self, a: &Auth) -> Result<SecurityStatus> {
        let (passkey_count, authenticator) = self.factor_counts(a)?;
        let enrolled = passkey_count > 0 || authenticator;
        let verified: Option<(i64,)> = self.platform.one_as(
            "SELECT verified_at FROM session_security WHERE session_hash=?",
            [&a.hash],
        )?;
        let at = verified.map_or(0, |row| row.0);
        Ok(SecurityStatus {
            enrolled,
            required: enrolled,
            verified: at > 0,
            recent: at > now() - self.config.security.fresh_auth_seconds * 1000,
            passkey_count,
            authenticator,
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
            self.ensure_recent_password(a)
        }
    }

    fn ensure_recent_password(&self, a: &Auth) -> Result<()> {
        ensure(
            self.platform.count(
                "SELECT count(*) FROM sessions s LEFT JOIN session_security x ON x.session_hash=s.hash \
                 WHERE s.hash=? AND MAX(s.created_at,COALESCE(x.password_verified_at,0))>?",
                params![
                    a.hash,
                    now() - self.config.security.fresh_auth_seconds * 1000
                ],
            )? == 1,
            "sign_in_again",
            403,
        )
    }

    fn ensure_enrollment_allowed(&self, a: &Auth) -> Result<()> {
        if self.security_status(a)?.enrolled {
            self.ensure_recent(a)
        } else {
            self.ensure_recent_password(a)
        }
    }

    fn passkeys(&self, a: &Auth) -> Result<Vec<Passkey>> {
        self.platform
            .query_as::<(String,)>(
                "SELECT credential FROM account_passkeys WHERE user_id=? ORDER BY id",
                [&a.user.id],
            )?
            .into_iter()
            .map(|(credential,)| Ok(serde_json::from_str(&credential)?))
            .collect()
    }

    pub fn passkey_list(&self, a: &Auth) -> Result<Vec<PasskeySummary>> {
        self.platform.query_as(
            "SELECT id,name,created_at FROM account_passkeys WHERE user_id=? ORDER BY created_at",
            [&a.user.id],
        )
    }

    fn challenge_binding(a: &Auth, kind: &str) -> String {
        format!("security-challenge:{}:{kind}", a.hash)
    }

    fn save_challenge<T: serde::Serialize>(&self, a: &Auth, kind: &str, state: &T) -> Result<()> {
        self.throttle(&format!("mfa-start:{}", a.user.id), 20, 60000)?;
        self.platform.exec(
            "DELETE FROM security_challenges WHERE expires_at<?",
            [now()],
        )?;
        let state = crypto::encrypt(
            &self.key,
            &Self::challenge_binding(a, kind),
            &serde_json::to_value(state)?,
        )?;
        self.platform.exec(
            "INSERT INTO security_challenges VALUES (?,?,?,?) ON CONFLICT(session_hash) \
             DO UPDATE SET kind=excluded.kind,state=excluded.state,expires_at=excluded.expires_at",
            params![a.hash, kind, state, now() + CHALLENGE_TTL],
        )?;
        Ok(())
    }

    fn read_challenge<T: serde::de::DeserializeOwned>(
        &self,
        a: &Auth,
        kind: &str,
        consume: bool,
    ) -> Result<T> {
        self.throttle(&format!("mfa-finish:{}", a.user.id), 10, 60000)?;
        let row: Option<(String,)> = self.platform.one_as(
            "SELECT state FROM security_challenges WHERE session_hash=? AND kind=? AND expires_at>?",
            params![a.hash, kind, now()],
        )?;
        if consume {
            self.platform.exec(
                "DELETE FROM security_challenges WHERE session_hash=?",
                [&a.hash],
            )?;
        }
        let (state,) = row.ok_or_else(|| Error::new("verification_expired", 409))?;
        let value = crypto::decrypt(&self.key, &Self::challenge_binding(a, kind), &state)
            .map_err(|_| Error::new("verification_expired", 409))?;
        Ok(serde_json::from_value(value)?)
    }

    pub fn passkey_register_start(&self, a: &Auth) -> Result<Value> {
        self.ensure_enrollment_allowed(a)?;
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
        self.save_challenge(a, "passkey-register", &state)?;
        Ok(serde_json::to_value(challenge)?)
    }

    pub fn passkey_register_finish(
        &self,
        a: &Auth,
        credential: Value,
        name: &str,
    ) -> Result<Vec<String>> {
        self.ensure_enrollment_allowed(a)?;
        let state: PasskeyRegistration = self.read_challenge(a, "passkey-register", true)?;
        let credential: RegisterPublicKeyCredential = serde_json::from_value(credential)?;
        let key = webauthn(self)?
            .finish_passkey_registration(&credential, &state)
            .map_err(|_| Error::new("passkey_failed", 400))?;
        let id = crypto::sha(serde_json::to_string(key.cred_id())?);
        self.platform.transaction(|| {
            let first = !self.security_status(a)?.enrolled;
            ensure(
                self.platform
                    .count("SELECT count(*) FROM account_passkeys WHERE id=?", [&id])?
                    == 0,
                "passkey_exists",
                409,
            )?;
            self.platform.exec(
                "INSERT INTO account_passkeys VALUES (?,?,?,?,?)",
                params![id, a.user.id, serde_json::to_string(&key)?, name, now()],
            )?;
            self.finish_enrollment(a, first, "account.passkey_added")
        })
    }

    pub fn passkey_verify_start(&self, a: &Auth) -> Result<Value> {
        let keys = self.passkeys(a)?;
        ensure(!keys.is_empty(), "passkey_unavailable", 409)?;
        let (challenge, state) = webauthn(self)?
            .start_passkey_authentication(&keys)
            .map_err(|_| Error::new("passkey_failed", 400))?;
        self.save_challenge(a, "passkey-verify", &state)?;
        Ok(serde_json::to_value(challenge)?)
    }

    pub fn passkey_verify_finish(&self, a: &Auth, credential: Value) -> Result<()> {
        let state: PasskeyAuthentication = self.read_challenge(a, "passkey-verify", true)?;
        let credential: PublicKeyCredential = serde_json::from_value(credential)?;
        let result = webauthn(self)?
            .finish_passkey_authentication(&credential, &state)
            .map_err(|_| Error::new("passkey_failed", 403))?;
        self.platform.transaction(|| {
            let mut matched = false;
            for mut key in self.passkeys(a)? {
                if key.update_credential(&result).is_some() {
                    let id = crypto::sha(serde_json::to_string(key.cred_id())?);
                    self.platform.exec(
                        "UPDATE account_passkeys SET credential=? WHERE id=? AND user_id=?",
                        params![serde_json::to_string(&key)?, id, a.user.id],
                    )?;
                    matched = true;
                }
            }
            ensure(matched, "passkey_failed", 403)?;
            self.verify_session(a)?;
            self.audit(
                Some(&a.user.id),
                None,
                "account.second_factor_verified",
                "passkey",
            )
        })
    }

    pub fn authenticator_register_start(&self, a: &Auth) -> Result<AuthenticatorSetup> {
        self.ensure_enrollment_allowed(a)?;
        ensure(
            !self.security_status(a)?.authenticator,
            "authenticator_exists",
            409,
        )?;
        let secret = base32(&crypto::random::<20>()?);
        self.save_challenge(a, "authenticator-register", &secret)?;
        let label: String =
            url::form_urlencoded::byte_serialize(format!("Dispatch:{}", a.user.email).as_bytes())
                .collect();
        let uri = format!(
            "otpauth://totp/{label}?secret={secret}&issuer=Dispatch&algorithm=SHA1&digits=6&period=30"
        );
        let svg = QrCode::new(uri.as_bytes())
            .map_err(|_| Error::new("authenticator_unavailable", 503))?
            .render::<svg::Color>()
            .min_dimensions(240, 240)
            .build();
        Ok(AuthenticatorSetup {
            secret,
            qr_code: format!("data:image/svg+xml;base64,{}", BASE64.encode(svg)),
        })
    }

    pub fn authenticator_register_finish(&self, a: &Auth, code: &str) -> Result<Vec<String>> {
        self.ensure_enrollment_allowed(a)?;
        let secret: String = self.read_challenge(a, "authenticator-register", false)?;
        let decoded =
            decode_base32(&secret).ok_or_else(|| Error::new("authenticator_unavailable", 409))?;
        let counter = matching_totp(&decoded, code, now())
            .ok_or_else(|| Error::new("invalid_authenticator_code", 403))?;
        let encrypted = crypto::encrypt(
            &self.key,
            &format!("authenticator:{}", a.user.id),
            &serde_json::json!(secret),
        )?;
        self.platform.transaction(|| {
            let first = !self.security_status(a)?.enrolled;
            ensure(
                self.platform.count(
                    "SELECT count(*) FROM authenticator_apps WHERE user_id=?",
                    [&a.user.id],
                )? == 0,
                "authenticator_exists",
                409,
            )?;
            self.platform.exec(
                "INSERT INTO authenticator_apps(user_id,secret,created_at,last_counter) VALUES (?,?,?,?)",
                params![a.user.id, encrypted, now(), counter],
            )?;
            self.platform.exec(
                "DELETE FROM security_challenges WHERE session_hash=?",
                [&a.hash],
            )?;
            self.finish_enrollment(a, first, "account.authenticator_added")
        })
    }

    pub fn authenticator_verify(&self, a: &Auth, code: &str) -> Result<()> {
        self.throttle(&format!("totp:{}", a.user.id), 5, 5 * 60000)?;
        let row: Option<(String, i64)> = self.platform.one_as(
            "SELECT secret,last_counter FROM authenticator_apps WHERE user_id=?",
            [&a.user.id],
        )?;
        let (encrypted, last_counter) =
            row.ok_or_else(|| Error::new("authenticator_unavailable", 409))?;
        let value = crypto::decrypt(
            &self.key,
            &format!("authenticator:{}", a.user.id),
            &encrypted,
        )?;
        let secret = value
            .as_str()
            .ok_or_else(|| Error::new("authenticator_unavailable", 409))?;
        let decoded =
            decode_base32(secret).ok_or_else(|| Error::new("authenticator_unavailable", 409))?;
        let counter = matching_totp(&decoded, code, now())
            .filter(|counter| *counter > last_counter)
            .ok_or_else(|| Error::new("invalid_authenticator_code", 403))?;
        self.platform.transaction(|| {
            ensure(
                self.platform.exec(
                    "UPDATE authenticator_apps SET last_counter=? WHERE user_id=? AND last_counter<?",
                    params![counter, a.user.id, counter],
                )? == 1,
                "invalid_authenticator_code",
                403,
            )?;
            self.verify_session(a)?;
            self.audit(
                Some(&a.user.id),
                None,
                "account.second_factor_verified",
                "authenticator",
            )
        })
    }

    fn finish_enrollment(&self, a: &Auth, first: bool, action: &str) -> Result<Vec<String>> {
        self.verify_session(a)?;
        self.revoke_other_sessions(a)?;
        self.audit(Some(&a.user.id), None, action, "")?;
        if first {
            self.create_recovery_codes(a)
        } else {
            Ok(Vec::new())
        }
    }

    fn verify_session(&self, a: &Auth) -> Result<()> {
        self.platform.exec(
            "INSERT INTO session_security(session_hash,verified_at) VALUES (?,?) \
             ON CONFLICT(session_hash) DO UPDATE SET verified_at=excluded.verified_at",
            params![a.hash, now()],
        )?;
        Ok(())
    }

    fn disable_if_last_factor(&self, a: &Auth) -> Result<()> {
        if !self.security_status(a)?.enrolled {
            self.platform
                .exec("DELETE FROM recovery_codes WHERE user_id=?", [&a.user.id])?;
            self.platform.exec(
                "DELETE FROM security_challenges WHERE session_hash IN \
                 (SELECT hash FROM sessions WHERE user_id=?)",
                [&a.user.id],
            )?;
            self.platform.exec(
                "DELETE FROM session_security WHERE session_hash=?",
                [&a.hash],
            )?;
        }
        Ok(())
    }

    pub fn remove_passkey(&self, a: &Auth, id: &str) -> Result<()> {
        self.ensure_recent(a)?;
        self.platform.transaction(|| {
            ensure(
                self.platform.exec(
                    "DELETE FROM account_passkeys WHERE id=? AND user_id=?",
                    [id, &a.user.id],
                )? == 1,
                "passkey_not_found",
                404,
            )?;
            self.revoke_other_sessions(a)?;
            self.disable_if_last_factor(a)?;
            self.audit(Some(&a.user.id), None, "account.passkey_removed", "")
        })
    }

    pub fn remove_authenticator(&self, a: &Auth) -> Result<()> {
        self.ensure_recent(a)?;
        self.platform.transaction(|| {
            ensure(
                self.platform.exec(
                    "DELETE FROM authenticator_apps WHERE user_id=?",
                    [&a.user.id],
                )? == 1,
                "authenticator_not_found",
                404,
            )?;
            self.revoke_other_sessions(a)?;
            self.disable_if_last_factor(a)?;
            self.audit(Some(&a.user.id), None, "account.authenticator_removed", "")
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
        for _ in 0..10 {
            let code = crypto::recovery_code()?;
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
                    params![crypto::sha(code.trim()), a.user.id],
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
        self.platform
            .query_as::<(String, i64, i64, Option<String>)>(
                "SELECT s.hash,s.created_at,s.expires_at,m.device FROM sessions s \
             LEFT JOIN session_metadata m ON m.session_hash=s.hash \
             WHERE s.user_id=? AND s.expires_at>? ORDER BY s.created_at DESC LIMIT 100",
                params![a.user.id, now()],
            )?
            .into_iter()
            .map(|(hash, created_at, expires_at, device)| {
                Ok(AccountSession {
                    id: crypto::sign(&self.key, &format!("session-id:{hash}")),
                    created_at,
                    expires_at,
                    current: hash == a.hash,
                    device,
                })
            })
            .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_and_totp_match_the_standard_vectors() {
        assert_eq!(
            base32(b"12345678901234567890"),
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        );
        assert_eq!(
            decode_base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap(),
            b"12345678901234567890"
        );
        assert!(decode_base32("NOT+A+SETUP+KEY").is_none());
        assert_eq!(totp(b"12345678901234567890", 1), "287082");
        assert_eq!(
            matching_totp(b"12345678901234567890", "287082", 30000),
            Some(1)
        );
        assert_eq!(
            matching_totp(b"12345678901234567890", "287082", 120000),
            None
        );
    }
}
