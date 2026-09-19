//! Collection jobs: listing, requesting and cancelling them.
use crate::{
    Error, Result, State, browsers,
    contracts::CollectionRequest,
    db::{Store, n, s},
    http::{
        input::{Input, Reply},
        route::{Dsp, Grant, Member, PlatformOwner, Route, User, async_post, read, write},
    },
    meals, validate as v,
};
use std::sync::Arc;

const RUN: Dsp = Dsp("collections.run");

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/platform/jobs", PlatformOwner, all_jobs),
        read("/api/dsp/jobs", RUN, jobs),
        write("/api/dsp/jobs", RUN, collect),
        async_post("/api/dsp/jobs/{id}/cancel", RUN, cancel),
        read(
            "/api/dsp/jobs/meal-breaks",
            Dsp("timecard.view"),
            meal_sync_status,
        ),
        write("/api/dsp/jobs/meal-breaks", RUN, sync_meal_breaks),
        write(
            "/api/dsp/cortex/meal-breaks/collect",
            RUN,
            collect_cortex_meal_breaks,
        ),
    ]
}

fn all_jobs(db: &Store, _: &User, _: &Input) -> Result<Reply> {
    Ok(Reply::json(db.list_jobs(None)?))
}

fn jobs(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Ok(Reply::json(db.list_jobs(Some(c.dsp_id()))?))
}

fn collect(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let request = CollectionRequest::parse(&input.body, false)?;
    let (id, actor) = (c.dsp_id(), Some(c.actor()));
    let job = if let Some(date) = &request.date {
        db.enqueue_paycom_date(id, actor, &request.request_id, date)?
    } else {
        db.enqueue(id, actor, &request.request_id)?
    };
    let date = request.date.as_deref().unwrap_or("");
    db.audit(actor, Some(id), "collection.requested", date)?;
    Ok(Reply::status(job, 202))
}

// A running job owns a browser, which is closed outside the database; the
// member's permission is then checked once more before the answer is given.
async fn cancel(state: Arc<State>, input: Input, access: Dsp) -> Result<Reply> {
    let job = input.param("id").to_owned();
    let (context, result, active_revision) = state
        .run(move |db| {
            let c = access.authorize(db, &input)?;
            v::fields(&input.body, &[])?;
            let row = db.job(&job, Some(s(&c.dsp, "id")))?;
            let active = ["running", "waiting_verification"].contains(&s(&row, "status"));
            let active_revision = if active {
                let provider = browsers::Provider::from_job_kind(s(&row, "kind"))?;
                Some((n(&row, "connection_revision"), provider))
            } else {
                None
            };
            let result = db.cancel_job(&job, s(&c.dsp, "id"))?;
            let actor = Some(s(&c.auth.user, "id"));
            db.audit(actor, Some(s(&c.dsp, "id")), "collection.cancelled", "")?;
            Ok((c, result, active_revision))
        })
        .await?;
    if let Some((revision, provider)) = active_revision {
        state
            .browsers
            .revoke_provider_revision(s(&context.dsp, "id"), revision, provider)
            .await;
    }
    state
        .run(move |db| access.revalidate(db, &context).map(|_| ()))
        .await?;
    Ok(Reply::json(result))
}

fn meal_sync_status(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    v::fields(&input.query, &["date"])?;
    let date = v::text(&input.query, "date", 10, 10)?;
    Ok(Reply::json(db.meal_sync_status(c.dsp_id(), date)?))
}

fn sync_meal_breaks(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let request = CollectionRequest::parse(&input.body, true)?;
    let date = request
        .date
        .as_deref()
        .ok_or_else(|| Error::new("invalid_input", 400))?;
    let (id, actor) = (c.dsp_id(), c.actor());
    let result = db.enqueue_meal_sync(id, actor, &request.request_id, date)?;
    db.audit(Some(actor), Some(id), "meal_breaks.sync_requested", date)?;
    Ok(Reply::status(result, 202))
}

fn collect_cortex_meal_breaks(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let b = &input.body;
    let scope = meals::Scope::request(b, s(&c.dsp, "timezone"))?;
    let (id, actor) = (c.dsp_id(), Some(c.actor()));
    let job = db.enqueue_meals(id, actor, v::text(b, "requestId", 1, 128)?, &scope)?;
    db.audit(actor, Some(id), "cortex.collection.requested", "")?;
    Ok(Reply::status(job, 202))
}
