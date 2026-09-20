//! A DSP's own profile.
use crate::{
    Result,
    contracts::DspSetupRequest,
    db::Store,
    http::{
        input::{Input, Reply},
        route::{Dsp, Member, Route, write},
    },
};

pub fn routes() -> Vec<Route> {
    vec![write("/api/dsp/profile", Dsp("settings.manage"), save_profile).invalidates_schedules()]
}

fn save_profile(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let profile = DspSetupRequest::parse(&input.body)?;
    db.complete_dsp_profile(c.dsp_id(), c.actor(), &profile)?;
    Ok(Reply::ok())
}
