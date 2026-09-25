//! Scorecard storage: publication, supersession, weeks not posted and what a
//! schedule queues.
mod common;
use dispatch_backend::{
    collectors::Provider,
    db::{Store, s},
    scorecard::{self, Capture, Request},
};
use serde_json::{Value, json};

fn request(week: &str) -> Request {
    Request::parse(&json!({"collection":"scorecard","week":week,"station":"DOT4"}))
        .unwrap()
        .unwrap()
}
/// A DSP with a station and an enabled Cortex connection.
fn ready() -> (tempfile::TempDir, Store, String) {
    let (root, db, id) = common::bootstrapped();
    db.set_profile(
        &id,
        json!({"stationCode":"DOT4","abbreviation":"FSCL","setupRequired":false}),
    )
    .unwrap();
    db.collector(&id, Provider::Cortex)
        .unwrap()
        .exec("UPDATE connections SET enabled=1,status='ready'", [])
        .unwrap();
    (root, db, id)
}
/// Queues `week` and publishes `capture` as that job's outcome.
fn publish(db: &Store, id: &str, key: &str, week: &str, capture: &Capture) -> String {
    let job = db.enqueue_scorecard(id, None, key, Some(week)).unwrap();
    let job = s(&job, "id").to_owned();
    db.publish_scorecard(id, &job, capture).unwrap();
    job
}

#[test]
fn a_posted_week_is_published_into_one_table_per_dataset_with_its_keys() {
    let (_root, db, id) = ready();
    let capture = scorecard::fixture(&request("2026-W38")).unwrap();
    let job = publish(&db, &id, "first", "2026-W38", &capture);
    let queued: Value = db.job(&job, Some(&id)).unwrap();
    assert_eq!(queued["kind"], "cortex.scorecard.collect");
    let storage = db.scorecard(&id).unwrap();
    let publication = storage
        .one(
            "SELECT * FROM scorecard_publications WHERE job_id=?",
            [&job],
        )
        .unwrap()
        .unwrap();
    assert_eq!(publication["active"], 1);
    assert_eq!(publication["week"], "2026-W38");
    assert_eq!(publication["row_count"], capture.row_count() as i64);
    for dataset in scorecard::DATASETS {
        let captured = capture
            .datasets
            .iter()
            .find(|d| d.id == dataset.id)
            .unwrap();
        let count = storage
            .count(
                &format!(
                    "SELECT count(*) FROM {} WHERE publication_id=? AND week='2026-W38'",
                    dataset.table
                ),
                [s(&publication, "id")],
            )
            .unwrap();
        assert_eq!(count as usize, captured.rows.len(), "{}", dataset.table);
    }
    // Rows keep every field, and the keys are read from them.
    let returns = storage
        .all(
            "SELECT tracking_id,transporter_id,impact,json_extract(row,'$.rts_reason_code') reason \
             FROM returns_to_station WHERE publication_id=? ORDER BY row_index",
            [s(&publication, "id")],
        )
        .unwrap();
    assert_eq!(
        returns,
        vec![
            json!({"tracking_id":"TBA000000000001","transporter_id":"driver-1","impact":1,"reason":"BUSINESS CLOSED"}),
            json!({"tracking_id":"TBA000000000002","transporter_id":"driver-2","impact":0,"reason":"CUSTOMER UNAVAILABLE"}),
        ]
    );
    assert_eq!(
        storage
            .all("SELECT data_date,event_id,impact FROM safety_events", [])
            .unwrap(),
        vec![json!({"data_date":"2026-09-19","event_id":"90000001","impact":1})]
    );
    let weeks = db.scorecard_weeks(&id).unwrap();
    assert_eq!(weeks.station, "DOT4");
    assert_eq!(weeks.weeks.len(), 1);
    let week = &weeks.weeks[0];
    assert!(week.posted);
    let published = week.publication.as_ref().unwrap();
    assert_eq!(published.row_count, capture.row_count());
    assert_eq!(published.dsp_code, "FXTR");
    assert_eq!(
        published
            .datasets
            .iter()
            .find(|d| d.table == "pickup_failures")
            .unwrap()
            .rows,
        0
    );
    // The same request queues the same job again.
    assert_eq!(
        s(
            &db.enqueue_scorecard(&id, None, "first", Some("2026-W38"))
                .unwrap(),
            "id"
        ),
        job
    );
}

#[test]
fn collecting_a_week_again_supersedes_its_publication_and_keeps_the_history() {
    let (_root, db, id) = ready();
    let capture = scorecard::fixture(&request("2026-W37")).unwrap();
    let first = publish(&db, &id, "one", "2026-W37", &capture);
    let mut again = capture.clone();
    again.datasets[1].rows.pop();
    again.started_at += 1000;
    again.finished_at += 2000;
    let second = publish(&db, &id, "two", "2026-W37", &again);
    let storage = db.scorecard(&id).unwrap();
    assert_eq!(
        storage
            .all(
                "SELECT job_id,active FROM scorecard_publications ORDER BY collected_at",
                []
            )
            .unwrap(),
        vec![
            json!({"job_id":first,"active":0}),
            json!({"job_id":second,"active":1})
        ]
    );
    let weeks = db.scorecard_weeks(&id).unwrap();
    assert_eq!(
        weeks.weeks[0].publication.as_ref().unwrap().row_count,
        again.row_count()
    );
    // Rows of the superseded publication are still there, and go with it.
    assert_eq!(
        storage
            .count("SELECT count(*) FROM returns_to_station", [])
            .unwrap(),
        3
    );
    storage
        .exec("DELETE FROM scorecard_publications WHERE active=0", [])
        .unwrap();
    assert_eq!(
        storage
            .count("SELECT count(*) FROM returns_to_station", [])
            .unwrap(),
        1
    );
}

#[test]
fn a_week_not_posted_yet_is_noted_without_a_publication() {
    let (_root, db, id) = ready();
    let mut capture = scorecard::fixture(&request("2026-W36")).unwrap();
    for dataset in &mut capture.datasets {
        dataset.rows.clear();
    }
    capture.posted = false;
    let job = publish(&db, &id, "empty", "2026-W36", &capture);
    let storage = db.scorecard(&id).unwrap();
    assert!(
        storage
            .one(
                "SELECT id FROM scorecard_publications WHERE job_id=?",
                [&job]
            )
            .unwrap()
            .is_none()
    );
    let weeks = db.scorecard_weeks(&id).unwrap();
    assert_eq!(weeks.weeks.len(), 1);
    assert!(!weeks.weeks[0].posted);
    assert!(weeks.weeks[0].publication.is_none());
    // A capture that claims a posted week without the DSP's own row is refused.
    let mut wrong = capture.clone();
    wrong.posted = true;
    assert!(wrong.validate(&request("2026-W36")).is_err());
}

#[test]
fn a_schedule_queues_the_newest_week_then_backfills_and_refreshes_within_the_limit() {
    let (_root, db, id) = ready();
    let jobs = db.scorecard_jobs(&id).unwrap();
    assert_eq!(jobs.len(), scorecard::MAX_JOBS_PER_RUN);
    let latest = db.scorecard_weeks(&id).unwrap().latest_week;
    assert_eq!(jobs[0].0, format!("scorecard:{latest}"));
    assert_eq!(jobs[0].1["station"], "DOT4");
    let expected = scorecard::weeks_before(&latest, scorecard::MAX_JOBS_PER_RUN - 1).unwrap();
    let keys: Vec<String> = jobs.iter().map(|(key, _)| key.clone()).collect();
    let expected_keys: Vec<String> = expected
        .iter()
        .map(|week| format!("scorecard:{week}"))
        .collect();
    assert_eq!(keys, expected_keys);
    // Once the newest week is published and the next is checked, the run moves on
    // to the weeks it has never seen.
    publish(
        &db,
        &id,
        "latest",
        &latest,
        &scorecard::fixture(&request(&latest)).unwrap(),
    );
    let mut empty = scorecard::fixture(&request(&expected[1])).unwrap();
    for dataset in &mut empty.datasets {
        dataset.rows.clear();
    }
    empty.posted = false;
    publish(&db, &id, "next", &expected[1], &empty);
    let jobs = db.scorecard_jobs(&id).unwrap();
    let keys: Vec<String> = jobs.iter().map(|(key, _)| key.clone()).collect();
    assert!(!keys.contains(&format!("scorecard:{latest}")), "{keys:?}");
    assert!(
        !keys.contains(&format!("scorecard:{}", expected[1])),
        "{keys:?}"
    );
    assert_eq!(keys[0], format!("scorecard:{}", expected[2]));
    // A publication older than the refresh interval is collected again; an older
    // unposted check is asked again after its interval.
    let storage = db.scorecard(&id).unwrap();
    storage
        .exec(
            "UPDATE scorecard_publications SET collected_at='2020-01-01T00:00:00.000Z' WHERE week=?",
            [&latest],
        )
        .unwrap();
    storage
        .exec(
            "UPDATE scorecard_weeks SET checked_at='2020-01-01T00:00:00.000Z' WHERE week=?",
            [&expected[1]],
        )
        .unwrap();
    let keys: Vec<String> = db
        .scorecard_jobs(&id)
        .unwrap()
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    assert_eq!(keys[0], format!("scorecard:{latest}"));
    assert_eq!(keys[1], format!("scorecard:{}", expected[1]));
    // Without a station there is nothing to ask for.
    db.set_profile(&id, json!({"stationCode":""})).unwrap();
    assert_eq!(
        db.scorecard_jobs(&id).unwrap_err().code,
        "scorecard_station_required"
    );
    assert_eq!(
        db.enqueue_scorecard(&id, None, "none", None)
            .unwrap_err()
            .code,
        "scorecard_station_required"
    );
}
