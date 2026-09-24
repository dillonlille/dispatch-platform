//! A DSP's members, roles and invitations, and the public pages an invitation links to.
use crate::{
    Error, Result, State,
    contracts::Presence,
    contracts::{InvitationRequest, Member as PublicMember},
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Anyone, Dsp, Member, Public, Route, async_post, read, write},
    },
    roles, validate as v,
};
use serde_json::{Value, json};
use std::sync::Arc;

// Anyone who works with the team needs the member and role lists to do so.
pub const TEAM: &str = "members.invite|members.manage|roles.manage";

const INVITATIONS: &str = "SELECT i.email,COALESCE(r.name,i.role) role,i.expires_at expiresAt,\
    i.used_at IS NOT NULL accepted FROM invitations i LEFT JOIN roles r ON r.id=i.role_id \
    WHERE i.dsp_id=? ORDER BY i.expires_at DESC LIMIT 100";
const REVOKE_INVITATION: &str =
    "DELETE FROM invitations WHERE dsp_id=? AND email=? COLLATE NOCASE AND used_at IS NULL";

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/members", Dsp(TEAM), members),
        write("/api/dsp/members/invite", Dsp("members.invite"), invite),
        write(
            "/api/dsp/members/{id}",
            Dsp("members.manage"),
            set_member_role,
        ),
        read("/api/dsp/invitations", Dsp("members.invite"), invitations),
        write(
            "/api/dsp/invitations/revoke",
            Dsp("members.invite"),
            revoke_invitation,
        ),
        read("/api/dsp/roles", Dsp(TEAM), list_roles),
        write("/api/dsp/roles", Dsp("roles.manage"), create_role),
        write("/api/dsp/roles/{id}", Dsp("roles.manage"), update_role),
        write(
            "/api/dsp/roles/{id}/remove",
            Dsp("roles.manage"),
            remove_role,
        ),
        // Reading an invitation counts against a throttle, which is a write.
        write("/api/invitations/{token}", Public, invitation).get(),
        async_post("/api/invitations/{token}/accept", Public, accept_invitation),
    ]
}

fn members(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    let members: Vec<PublicMember> = db
        .members(c.dsp_id())?
        .into_iter()
        .map(|member| {
            let status = c.state.presence.status(c.dsp_id(), &member.user_id);
            let status = Presence::parse(status).unwrap_or(Presence::Offline);
            member.public(status)
        })
        .collect();
    Reply::of(&members)
}

fn invite(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (b, id) = (&input.body, c.dsp_id());
    v::fields(b, &["email", "role"])?;
    let email = v::email(b, "email")?;
    let role = db.role(id, v::text(b, "role", 1, 100)?)?;
    db.platform.transaction(|| {
        let raw = db.invite(&c.auth, id, &email, &role.id)?;
        // The first owner of a DSP that is still being set up is also asked to finish that.
        let setup = role.system && db.profile(id)?.setup_required;
        db.invitation_mail(&c.auth, &email, &c.dsp.name, &role.name, &raw, setup)
    })?;
    Ok(Reply::json(
        json!({"invitation":{"email":email,"status":"queued"}}),
    ))
}

// A null role removes the member from the DSP.
fn set_member_role(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let b = &input.body;
    v::fields(b, &["role"])?;
    let role = if b["role"].is_null() {
        None
    } else {
        Some(v::text(b, "role", 1, 100)?)
    };
    db.set_role(c, input.param("id"), role)?;
    Ok(Reply::ok())
}

fn invitations(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Ok(Reply::json(json!(
        db.platform.all(INVITATIONS, [c.dsp_id()])?
    )))
}

fn revoke_invitation(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &["email"])?;
    let email = v::email(&input.body, "email")?;
    db.platform.exec(REVOKE_INVITATION, [c.dsp_id(), &email])?;
    db.audit(
        Some(c.actor()),
        Some(c.dsp_id()),
        "invitation.revoked",
        &email,
    )?;
    Ok(Reply::ok())
}

fn list_roles(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Reply::of(&db.roles(c.dsp_id())?)
}

fn create_role(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (name, permissions) = role_input(&input.body)?;
    Reply::of_status(&db.create_role(c, &name, &permissions)?, 201)
}

fn update_role(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (name, permissions) = role_input(&input.body)?;
    let role = db.update_role(c, input.param("id"), &name, &permissions)?;
    Reply::of(&role)
}

fn remove_role(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.body, &[])?;
    db.delete_role(c, input.param("id"))?;
    Ok(Reply::ok())
}

fn role_input(b: &Value) -> Result<(String, Vec<String>)> {
    v::fields(b, &["name", "permissions"])?;
    let permissions = b["permissions"]
        .as_array()
        .filter(|list| list.len() <= roles::PERMISSIONS.len())
        .and_then(|list| {
            list.iter()
                .map(|p| p.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(|| Error::new("invalid_input", 400))?;
    Ok((v::text(b, "name", 1, 60)?.to_owned(), permissions))
}

fn invitation(db: &Store, _: &Anyone, input: &Input) -> Result<Reply> {
    db.throttle(&format!("invite-read:{}", input.ip), 60, 60000)?;
    Ok(Reply::json(db.invitation_link(input.param("token"))?))
}

async fn accept_invitation(state: Arc<State>, input: Input, _: Public) -> Result<Reply> {
    let request = InvitationRequest::parse(&input.body)?;
    let key = format!("invite:{}", input.ip);
    state.run(move |db| db.throttle(&key, 20, 3600000)).await?;
    let token = input.param("token").to_owned();
    let setup = request.dsp_profile.is_some();
    let joined = state.accept_invitation(token, request, input.ip).await?;
    if setup {
        state
            .schedule_revision
            .fetch_add(1, std::sync::atomic::Ordering::Release);
    }
    Ok(Reply::json(joined))
}
