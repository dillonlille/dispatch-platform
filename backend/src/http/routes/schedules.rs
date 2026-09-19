//! Collection schedules. Every change here wakes the scheduler; a preview changes nothing.
use crate::{
    Result,
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Dsp, Member, Route, read, write},
    },
    schedules::schedule_changes,
};

const MANAGE: Dsp = Dsp("timecard.manage");

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/schedules", MANAGE, schedules),
        write("/api/dsp/schedules", MANAGE, create).invalidates_schedules(),
        write("/api/dsp/schedules/preview", MANAGE, preview),
        write("/api/dsp/schedules/{key}", MANAGE, update).invalidates_schedules(),
        write("/api/dsp/schedules/{key}/enabled", MANAGE, toggle).invalidates_schedules(),
        write("/api/dsp/schedules/{key}/remove", MANAGE, remove).invalidates_schedules(),
    ]
}

fn schedules(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Reply::of(&db.collection_schedules(c.dsp_id())?)
}

fn preview(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    Reply::of(&db.preview_schedule(c.dsp_id(), &input.body)?)
}

fn create(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let id = c.dsp_id();
    let result = db.save_schedule(id, None, &input.body)?;
    let name = result.name.as_str();
    let subject = Some(("schedule", result.id.as_str()));
    let actor = Some(c.actor());
    db.audit_ref(
        actor,
        Some(id),
        "schedule.created",
        name,
        Some(name),
        &[],
        subject,
    )?;
    Reply::of_status(&result, 201)
}

fn update(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (id, key) = (c.dsp_id(), input.param("key"));
    let before = db.collection_schedule(id, key)?;
    let result = db.save_schedule(id, Some(key), &input.body)?;
    db.audit_ref(
        Some(c.actor()),
        Some(id),
        "schedule.updated",
        &result.name,
        Some(&before.name),
        &schedule_changes(&before, &result),
        Some(("schedule", key)),
    )?;
    Reply::of(&result)
}

fn toggle(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (id, key) = (c.dsp_id(), input.param("key"));
    let before = db.collection_schedule(id, key)?;
    let result = db.enable_schedule(id, key, &input.body)?;
    db.audit_ref(
        Some(c.actor()),
        Some(id),
        "schedule.toggled",
        &result.name,
        Some(&result.name),
        &schedule_changes(&before, &result),
        Some(("schedule", key)),
    )?;
    Reply::of(&result)
}

fn remove(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (id, key) = (c.dsp_id(), input.param("key"));
    let before = db.collection_schedule(id, key)?;
    db.delete_collection_schedule(id, key, &input.body)?;
    let name = before.name.as_str();
    let subject = Some(("schedule", key));
    let actor = Some(c.actor());
    db.audit_ref(
        actor,
        Some(id),
        "schedule.deleted",
        name,
        Some(name),
        &[],
        subject,
    )?;
    Ok(Reply::ok())
}
