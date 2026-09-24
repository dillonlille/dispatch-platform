use super::*;
impl Store {
    pub fn invite(&self, a: &Auth, dsp: &str, email: &str, role: &str) -> Result<String> {
        let c = self.context(a, dsp, "members.invite")?;
        let role = self.role(dsp, role)?;
        self.ensure_assignable(&c, &role)?;
        ensure(self.config.mail_available(), "email_unavailable", 503)?;
        ensure(
            !email.eq_ignore_ascii_case(&a.user.email),
            "already_a_member",
            409,
        )?;
        ensure(
            self.platform.count(
                "SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id \
                 WHERE m.dsp_id=? AND u.email=? COLLATE NOCASE",
                [dsp, email],
            )? == 0,
            "already_a_member",
            409,
        )?;
        self.reserve_quota(
            &format!("mail:actor:{}", a.user.id),
            self.config.security.mail_actor_hourly,
            3600000,
        )?;
        self.reserve_quota(
            &format!("mail:dsp:{dsp}"),
            self.config.security.mail_tenant_hourly,
            3600000,
        )?;
        self.reserve_quota(
            &format!("mail:recipient:{}", email.to_lowercase()),
            self.config.security.mail_recipient_daily,
            86400000,
        )?;
        self.reserve_quota(
            &format!("mail:cooldown:{}", email.to_lowercase()),
            1,
            self.config.security.mail_cooldown_seconds * 1000,
        )?;
        ensure(
            self.platform.count(
                "SELECT count(*) FROM outbox o JOIN invitations i ON i.hash=o.invitation_hash \
             WHERE o.status='pending' AND i.dsp_id=?",
                [dsp],
            )? < self.config.security.mail_tenant_pending,
            "email_queue_full",
            429,
        )?;
        // A resend replaces the outstanding grant rather than accumulating links.
        self.platform.exec(
            "DELETE FROM invitations WHERE dsp_id=? AND email=? COLLATE NOCASE AND used_at IS NULL",
            [dsp, email],
        )?;
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
        ensure(
            self.inviter_authorized(&crypto::sha(raw))?,
            "invitation_expired",
            404,
        )?;
        let owner = flag(&invitation, "owner");
        invitation.as_object_mut().unwrap().remove("owner");
        let profile = self.profile(s(&invitation, "dspId"))?;
        invitation["onboarding"] = json!(owner && profile.setup_required);
        invitation["stationCode"] = json!(profile.station_code);
        Ok(invitation)
    }
    /// An outstanding invitation never outlives the authority that issued it.
    pub fn inviter_authorized(&self, hash: &str) -> Result<bool> {
        let row: Option<(String, String, String)> = self.platform.one_as(
            "SELECT created_by,dsp_id,role_id FROM invitations WHERE hash=?",
            [hash],
        )?;
        let Some((actor, dsp, role)) = row else {
            return Ok(false);
        };
        let Some(user) = UserRow::find(&self.platform, "id", &actor)? else {
            return Ok(false);
        };
        if !user.active() {
            return Ok(false);
        }
        if user.user.platform_owner {
            return Ok(true);
        }
        let Some(grant) = self.grant(&actor, &dsp)? else {
            return Ok(false);
        };
        let Some(role) = self.find_role(&dsp, &role)? else {
            return Ok(false);
        };
        Ok(grant.owner
            || (!role.system
                && grant.permissions.iter().any(|p| p == "members.invite")
                && role
                    .permissions
                    .iter()
                    .all(|p| grant.permissions.contains(p))))
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
        request: crate::contracts::InvitationRequest,
        ip: String,
    ) -> Result<Value> {
        let crate::contracts::InvitationRequest {
            first_name: first,
            last_name: last,
            password,
            dsp_profile,
        } = request;
        let token = raw.clone();
        let (invite, existing) = self
            .run(move |db| {
                db.throttle(&format!("invite-token:{}", crypto::sha(&token)), 10, 900000)?;
                let invite = db.invitation(&token)?;
                db.password_attempt(s(&invite, "email"), &ip)?;
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
