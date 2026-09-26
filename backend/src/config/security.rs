use crate::{Result, ensure};
use serde::Deserialize;

/// Operator tuning; tenant roles and permissions remain independent of abuse controls.
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct SecurityPolicy {
    pub password_ip_attempts: i64,
    pub password_account_attempts: i64,
    pub password_window_seconds: i64,
    pub mail_actor_hourly: i64,
    pub mail_tenant_hourly: i64,
    pub mail_recipient_daily: i64,
    pub mail_cooldown_seconds: i64,
    pub mail_tenant_pending: i64,
    pub mail_kind_pending: i64,
    pub fresh_auth_seconds: i64,
}
impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            password_ip_attempts: 30,
            password_account_attempts: 10,
            password_window_seconds: 900,
            mail_actor_hourly: 60,
            mail_tenant_hourly: 200,
            mail_recipient_daily: 5,
            mail_cooldown_seconds: 60,
            mail_tenant_pending: 100,
            mail_kind_pending: 500,
            fresh_auth_seconds: 300,
        }
    }
}
impl SecurityPolicy {
    pub fn parse(value: &str) -> Result<Self> {
        let policy: Self = serde_json::from_str(value)?;
        for (value, min, max) in [
            (policy.password_ip_attempts, 5, 100),
            (policy.password_account_attempts, 3, 30),
            (policy.password_window_seconds, 60, 900),
            (policy.mail_actor_hourly, 1, 500),
            (policy.mail_tenant_hourly, 1, 2000),
            (policy.mail_recipient_daily, 1, 10),
            (policy.mail_cooldown_seconds, 30, 3600),
            (policy.mail_tenant_pending, 1, 1000),
            (policy.mail_kind_pending, 10, 5000),
            (policy.fresh_auth_seconds, 60, 900),
        ] {
            ensure((min..=max).contains(&value), "invalid_security_policy", 400)?;
        }
        ensure(
            policy.mail_tenant_pending <= policy.mail_kind_pending,
            "invalid_security_policy",
            400,
        )?;
        Ok(policy)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_accepts_partial_tuning_but_rejects_disabled_controls_and_typos() {
        assert_eq!(
            SecurityPolicy::parse(r#"{"mailActorHourly":120}"#)
                .unwrap()
                .mail_actor_hourly,
            120
        );
        for value in [
            r#"{"mailActorHourly":0}"#,
            r#"{"freshAuthSeconds":86400}"#,
            r#"{"disableMfa":true}"#,
            r#"{"mailActorHourly":"120"}"#,
        ] {
            assert!(SecurityPolicy::parse(value).is_err());
        }
    }
}
