//! A DSP's own profile.
use crate::{
    Result,
    db::Store,
    ensure,
    http::{
        input::{Input, Reply},
        route::{Dsp, Member, Route, write},
    },
    validate as v,
};
use serde_json::json;

pub fn routes() -> Vec<Route> {
    vec![
        // The profile carries the timezone every schedule is read in.
        write("/api/dsp/profile", Dsp("settings.manage"), save_profile).invalidates_schedules(),
    ]
}

fn save_profile(db: &Store, c: &Member, input: &Input) -> Result<Reply> {
    let (b, id) = (&input.body, c.dsp_id());
    v::fields(b, &["name", "timezone", "abbreviation", "stationCode"])?;
    let name = v::name(b, "name", 100)?;
    let tz = v::timezone(b, "timezone")?;
    let abbreviation = v::text(b, "abbreviation", 0, 16)?.trim();
    let station = v::text(b, "stationCode", 3, 8)?;
    let alphanumeric = station.bytes().all(|b| b.is_ascii_alphanumeric());
    ensure(alphanumeric, "invalid_input", 400)?;
    let station = station.to_uppercase();
    db.update_dsp(c, &name, &tz)?;
    let profile = json!({
        "abbreviation":abbreviation,
        "stationCode":station,
        "setupRequired":false
    });
    db.set_profile(id, profile)?;
    let changes = [
        ("station", None, Some(station)),
        ("abbreviation", None, Some(abbreviation.to_owned())),
    ];
    let actor = Some(c.actor());
    db.audit_with(actor, Some(id), "dsp.profile_completed", "", None, &changes)?;
    Ok(Reply::ok())
}
