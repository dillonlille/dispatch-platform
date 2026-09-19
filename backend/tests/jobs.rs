mod common;
use common::{seeded, store};
use dispatch_backend::{
    db::{self, s},
    schedules,
};
use serde_json::json;

#[test]
fn queue_limits_and_authority_are_checked_again_before_publication() {
    let (_root, db) = seeded();
    let tenant = db
        .platform
        .one("SELECT id FROM dsps WHERE name='Northline Logistics'", [])
        .unwrap()
        .unwrap();
    let id = s(&tenant, "id");
    let user = db
        .platform
        .one("SELECT id FROM users WHERE platform_owner=1", [])
        .unwrap()
        .unwrap();
    let actor = s(&user, "id");
    db.enqueue(id, Some(actor), "request-0").unwrap();
    assert_eq!(
        db.enqueue(id, Some(actor), "another-manual")
            .unwrap_err()
            .code,
        "sync_in_progress"
    );
    // The underlying queue still bounds internal batches independently of the manual lock.
    for i in 1..5 {
        db.enqueue(id, None, &format!("request-{i}")).unwrap();
    }
    assert_eq!(db.enqueue(id, None, "overflow").unwrap_err().status, 429);
    let job = db.claim("worker", |_, _| true).unwrap().unwrap();
    let jid = s(&job, "id");
    db.guard_job(jid, "worker").unwrap();
    assert!(db.claim("second", |_, _| true).unwrap().is_none());
    db.platform
        .exec("UPDATE users SET status='disabled' WHERE id=?", [actor])
        .unwrap();
    assert_eq!(
        db.guard_job(jid, "worker").unwrap_err().code,
        "permission_denied"
    );
    db.platform
        .exec("UPDATE users SET status='active' WHERE id=?", [actor])
        .unwrap();
    db.collector(id, dispatch_backend::collectors::Provider::Paycom)
        .unwrap()
        .exec("UPDATE connections SET revision=revision+1", [])
        .unwrap();
    assert_eq!(
        db.guard_job(jid, "worker").unwrap_err().code,
        "connection_changed"
    );
    db.cancel_job(jid, id).unwrap();
    assert_eq!(
        db.guard_job(jid, "worker").unwrap_err().code,
        "job_cancelled"
    );
}

#[test]
fn listed_jobs_respect_the_cap_scope_names_and_attempt_order() {
    let (_root, db) = seeded();
    let dsps = db
        .platform
        .all("SELECT id,name FROM dsps ORDER BY id", [])
        .unwrap();
    for index in 0..204 {
        let dsp = &dsps[index % dsps.len()];
        let job = format!("job-{index}");
        db.jobs.exec("INSERT INTO jobs(id,dsp_id,environment,kind,status,available_at,created_at,release,connection_revision,idempotency_key) VALUES (?,?,'preview','paycom.collect','succeeded',0,?,'test',1,?)",rusqlite::params![job,s(dsp,"id"),format!("2026-09-01T{index:04}"),job]).unwrap();
        for attempt in [2, 1] {
            db.jobs
                .exec(
                    "INSERT INTO job_metrics(job_id,attempt,owner,metrics) VALUES (?,?,'test',?)",
                    rusqlite::params![job, attempt, json!({"attempt":attempt}).to_string()],
                )
                .unwrap();
        }
    }
    let recent = db.list_jobs(None).unwrap();
    assert_eq!(recent.as_array().unwrap().len(), 200);
    assert_eq!(recent[0]["id"], "job-203");
    assert_eq!(recent[0]["metrics"], json!([{"attempt":1},{"attempt":2}]));
    let dsp = &dsps[0];
    let scoped = db.list_jobs(Some(s(dsp, "id"))).unwrap();
    assert_eq!(scoped.as_array().unwrap().len(), 68);
    for row in scoped.as_array().unwrap() {
        assert_eq!(row["dspId"], dsp["id"]);
        assert_eq!(row["dspName"], dsp["name"]);
    }
}

#[test]
fn collection_outcomes_record_their_schedule_provider_date_and_duration() {
    let (_root, db) = store();
    let started = db::at(db::now() - 108_000);
    let job = json!({"kind":"paycom.collect","idempotency_key":"manual","request":"{\"date\":\"2026-09-18\"}","started_at":started});
    let (schedule, facts) = db.outcome_facts("missing", &job);
    assert!(schedule.is_none());
    assert_eq!(
        facts,
        [
            ("provider", None, Some("paycom".to_owned())),
            ("date", None, Some("2026-09-18".to_owned())),
            ("duration", None, Some("108".to_owned())),
        ]
    );
    let job = json!({"kind":"cortex.meal_breaks.collect","idempotency_key":"schedule:gone:2026:flex:0","request":"{}","started_at":null});
    let (schedule, facts) = db.outcome_facts("missing", &job);
    assert!(schedule.is_none());
    assert_eq!(facts, [("provider", None, Some("cortex".to_owned()))]);
}

#[test]
fn schedule_handles_dst_gaps_and_repeated_minutes() {
    let parse = |s: &str| {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(
        schedules::next_daily("02:30", "America/Chicago", parse("2026-03-08T07:59:00Z")).unwrap(),
        "2026-03-09T07:30:00.000Z"
    );
    assert_eq!(
        schedules::next_daily("01:30", "America/Chicago", parse("2026-11-01T06:30:00Z")).unwrap(),
        "2026-11-02T07:30:00.000Z"
    );
    assert!(schedules::next_daily("25:99", "UTC", 0).is_err());
}

#[test]
fn schedule_deadlines_track_changes_and_due_ticks_are_idempotent() {
    let (_root, db) = seeded();
    let dsp = db
        .platform
        .one("SELECT id FROM dsps WHERE name='Northline Logistics'", [])
        .unwrap()
        .unwrap();
    let id = s(&dsp, "id");
    assert!(
        !db.schedule_deadlines()
            .unwrap()
            .iter()
            .any(|(d, _)| d == id)
    );
    let schedule = db
        .save_collection_schedule(
            id,
            None,
            &json!({"name":"Morning","collection":"paycom","cadence":"daily","intervalMinutes":null,"localTime":"06:00","enabled":true}),
        )
        .unwrap();
    let key = s(&schedule, "id");
    assert!(
        db.schedule_deadlines()
            .unwrap()
            .iter()
            .any(|(d, at)| d == id && *at > db::now())
    );
    db.dsp(id)
        .unwrap()
        .exec(
            "UPDATE collection_schedules SET next_run='2026-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
    assert!(db.schedule_due(id).unwrap().unwrap() > db::now());
    assert!(db.schedule_due(id).unwrap().unwrap() > db::now());
    assert_eq!(db.list_jobs(Some(id)).unwrap().as_array().unwrap().len(), 1);
    db.enable_collection_schedule(
        id,
        key,
        &json!({"revision":schedule["revision"],"enabled":false}),
    )
    .unwrap();
    assert_eq!(db.schedule_due(id).unwrap(), None);
    assert!(
        !db.schedule_deadlines()
            .unwrap()
            .iter()
            .any(|(d, _)| d == id)
    );
}
