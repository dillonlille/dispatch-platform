use super::*;
use crate::contracts::AccountSession;

impl Store {
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
