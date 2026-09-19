use crate::{Error, Result, db, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    failures: u8,
    blocked_until: i64,
    pending: bool,
    manual: bool,
    recover: bool,
}
pub(super) struct Attempts {
    path: PathBuf,
    record: Record,
}
/// Refuses to start a browser for a provider that is cooling down.
pub(super) fn preflight(profile: &Path, provider: &str, retry: bool) -> Result<()> {
    Attempts::beside(profile, provider)?.check(retry)?;
    Ok(())
}
impl Attempts {
    /// A provider's attempt record lives beside its browser profile.
    pub fn beside(profile: &Path, provider: &str) -> Result<Self> {
        Self::open(
            &profile
                .parent()
                .ok_or_else(|| Error::new("unsafe_storage_path", 500))?
                .join(format!("{provider}-attempt.json")),
        )
    }
    pub fn open(path: &Path) -> Result<Self> {
        db::private_file(path, false)?;
        let mut record: Record = if path.exists() {
            ensure(
                std::fs::metadata(path)?.len() <= 4096,
                "attempt_state_invalid",
                409,
            )?;
            serde_json::from_slice(&std::fs::read(path)?)
                .map_err(|_| Error::new("attempt_state_invalid", 409))?
        } else {
            Record::default()
        };
        ensure(
            record.failures <= 3 && record.blocked_until >= 0,
            "attempt_state_invalid",
            409,
        )?;
        if record.pending {
            record.pending = false;
            record.manual = true;
            record.recover = true;
        }
        let this = Self {
            path: path.into(),
            record,
        };
        this.persist()?;
        Ok(this)
    }
    fn persist(&self) -> Result<()> {
        db::write_private(&self.path, &serde_json::to_vec(&self.record)?)
    }
    /// Interrupted submissions may only observe an existing authenticated session.
    pub fn check(&self, retry: bool) -> Result<bool> {
        ensure(
            self.record.blocked_until <= chrono::Utc::now().timestamp_millis(),
            "attempt_cooldown",
            409,
        )?;
        if self.record.manual && self.record.recover {
            return Ok(true);
        }
        ensure(
            !self.record.pending && (!self.record.manual || retry && self.record.failures < 3),
            "manual_verification_required",
            409,
        )?;
        Ok(false)
    }
    pub fn submitted(&mut self) -> Result<()> {
        self.record.pending = true;
        self.record.manual = false;
        self.record.recover = false;
        self.persist()
    }
    pub fn succeeded(&mut self) -> Result<()> {
        self.record = Record::default();
        self.persist()
    }
    pub fn failed(&mut self, code: &str) -> Result<()> {
        if !self.record.pending {
            return Ok(());
        }
        self.record.pending = false;
        if [
            "primary_credentials_rejected",
            "security_answers_rejected",
            "invalid_credentials",
        ]
        .contains(&code)
        {
            self.record.failures = (self.record.failures + 1).min(3);
            self.record.manual = self.record.failures == 3;
            self.record.blocked_until = chrono::Utc::now().timestamp_millis()
                + match self.record.failures {
                    1 => 300_000,
                    2 => 1_800_000,
                    _ => 0,
                };
            self.record.recover = false;
        } else {
            self.record.manual = true;
            self.record.recover =
                code != "manual_verification_required" && code != "account_locked";
        }
        self.persist()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cooldown_and_interruption_survive_restart() -> Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )?;
        let path = dir.path().join("attempt.json");
        let mut attempts = Attempts::open(&path)?;
        assert!(!attempts.check(false)?);
        attempts.submitted()?;
        let mut attempts = Attempts::open(&path)?;
        assert!(attempts.check(true)?);
        attempts.succeeded()?;
        attempts.submitted()?;
        attempts.failed("primary_credentials_rejected")?;
        assert_eq!(
            Attempts::open(&path)?.check(true).unwrap_err().code,
            "attempt_cooldown"
        );
        Ok(())
    }
    #[test]
    fn invalid_and_duplicate_state_is_rejected() -> Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )?;
        let path = dir.path().join("attempt.json");
        for bytes in [br#"{"failures":4,"blocked_until":0,"pending":false,"manual":false,"recover":false}"#.as_slice(),
            br#"{"failures":0,"failures":0,"blocked_until":0,"pending":false,"manual":false,"recover":false}"#] {
            db::write_private(&path,bytes)?;
            assert!(Attempts::open(&path).is_err());
        }
        Ok(())
    }
}
