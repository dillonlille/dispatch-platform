use super::*;
impl Store {
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
        invitation["onboarding"] = json!(owner && profile.setup_required);
        invitation["stationCode"] = json!(profile.station_code);
        Ok(invitation)
    }
    /// What an invitation's link shows: the open invitation, or that it was already accepted.
    pub fn invitation_link(&self, raw: &str) -> Result<Value> {
        let accepted = match raw.len() {
            43 => self.platform.one(
                ACCEPTED_INVITATION,
                params![crypto::sha(raw), self.config.environment],
            )?,
            _ => None,
        };
        match accepted {
            Some(mut accepted) => {
                accepted["accepted"] = json!(true);
                Ok(accepted)
            }
            None => self.invitation(raw),
        }
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
}
impl crate::State {
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
}
