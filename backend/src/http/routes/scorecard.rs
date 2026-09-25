//! Weekly scorecards: what is stored, and collecting a week.
use crate::{
    Result,
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Dsp, Member, Route, read, write},
    },
    scorecard, validate as v,
};

const RUN: Dsp = Dsp("collections.run");

pub fn routes() -> Vec<Route> {
    vec![
        read("/api/dsp/scorecard/weeks", Dsp("timecard.view"), weeks),
        write("/api/dsp/scorecard/collect", RUN, collect),
    ]
}

fn weeks(db: &Store, c: &Member, _: &Input) -> Result<Reply> {
    Reply::of(&db.scorecard_weeks(c.dsp_id())?)
}

/// Queues one week, the most recent completed one unless `week` names another.
fn collect(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let b = &input.body;
    v::fields(b, &["requestId", "week"])?;
    let key = v::text(b, "requestId", 1, 128)?;
    let week = if b.get("week").is_some() {
        let week = v::text(b, "week", 8, 8)?;
        scorecard::parse_week(week)?;
        Some(week)
    } else {
        None
    };
    let (id, actor) = (c.dsp_id(), Some(c.actor()));
    let job = db.enqueue_scorecard(id, actor, key, week)?;
    db.audit(
        actor,
        Some(id),
        "scorecard.collection_requested",
        week.unwrap_or(""),
    )?;
    Ok(Reply::status(job, 202))
}
