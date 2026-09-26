use super::*;
impl Store {
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
    pub fn recovery(&self, email: &str) -> Result<()> {
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        let found = UserRow::find(&self.platform, "email", &email.trim().to_lowercase())?;
        if let Some(UserRow { user, version, .. }) = found.filter(UserRow::active) {
            let raw = crypto::token()?;
            self.platform.transaction(|| {
                self.platform.exec(
                    "DELETE FROM outbox WHERE user_id=? AND kind='reset' AND status IN ('pending','failed')",
                    [&user.id],
                )?;
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
}
impl crate::State {
    pub async fn reauthenticate(
        self: &std::sync::Arc<Self>,
        auth: Auth,
        password: String,
        ip: String,
    ) -> Result<()> {
        let a = auth.clone();
        let row = self
            .run(move |db| {
                db.authenticate(&a.raw)?;
                db.password_attempt(&a.user.email, &ip)?;
                UserRow::find(&db.platform, "id", &a.user.id)?
                    .ok_or_else(|| Error::new("sign_in_required", 401))
            })
            .await?;
        let expected = row.clone();
        self.password_work(move || {
            ensure(
                crypto::check_password(&password, &expected.password),
                "invalid_password",
                403,
            )
        })
        .await?;
        self.run(move |db| {
            db.authenticate(&auth.raw)?;
            let fresh = UserRow::find(&db.platform, "id", &auth.user.id)?;
            ensure(
                fresh
                    .as_ref()
                    .is_some_and(|fresh| same_password_user(fresh, &row)),
                "sign_in_required",
                401,
            )?;
            db.platform.exec(
                "INSERT INTO session_security(session_hash,password_verified_at) VALUES (?,?) \
                 ON CONFLICT(session_hash) DO UPDATE SET password_verified_at=excluded.password_verified_at",
                params![auth.hash, now()],
            )?;
            Ok(())
        })
        .await
    }

    pub(super) async fn password_work<T: Send + 'static>(
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
        ip: String,
    ) -> Result<()> {
        let a = auth.clone();
        let row = self
            .run(move |db| {
                let a = db.authenticate(&a.raw)?;
                db.password_attempt(&a.user.email, &ip)?;
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
}

pub(super) fn same_password_user(a: &UserRow, b: &UserRow) -> bool {
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
