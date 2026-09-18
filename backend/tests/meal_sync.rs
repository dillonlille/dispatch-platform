use dispatch_backend::core::{
    collectors::Provider,
    config::Config,
    db::{Store, s},
    meals::{self, Scope},
    operations,
};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

fn fixture() -> (tempfile::TempDir, Store, String, String) {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = Config::load().unwrap();
    config.root = root.path().into();
    config.fixture = true;
    config.development = true;
    config.environment = "preview".into();
    let db = Store::initialize(config).unwrap();
    let boot = operations::bootstrap(
        &db,
        "owner@example.test",
        "Test",
        "Owner",
        "test-password-long",
    )
    .unwrap();
    let id = s(&boot["dsp"], "id").to_owned();
    let actor = s(
        &db.platform
            .one("SELECT id FROM users LIMIT 1", [])
            .unwrap()
            .unwrap(),
        "id",
    )
    .to_owned();
    (root, db, id, actor)
}
fn enable(db: &Store, id: &str, provider: Provider) {
    db.collector(id, provider)
        .unwrap()
        .exec("UPDATE connections SET enabled=1,status='ready'", [])
        .unwrap();
}
fn seed(db: &Store, id: &str, date: &str, index: usize) {
    let scope = Scope {
        date: date.into(),
        station: format!("DEM{index}"),
        service_area_id: format!("area-{index}"),
        provider: "provider-demo".into(),
        timezone: "America/Los_Angeles".into(),
    };
    db.publish_meals(
        id,
        &format!("seed-{date}-{index}"),
        &meals::fixture(&scope),
        &scope,
    )
    .unwrap();
}
fn jobs(db: &Store, id: &str) -> Vec<Value> {
    db.list_jobs(Some(id)).unwrap().as_array().unwrap().clone()
}
#[test]
fn first_sync_discovers_from_tenant_profile_and_replays_after_publication() {
    let (_root, db, id, actor) = fixture();
    enable(&db, &id, Provider::Paycom);
    enable(&db, &id, Provider::Cortex);
    db.set_profile(&id, json!({"stationCode":"DOT4", "abbreviation":"FSCL"}))
        .unwrap();
    assert_eq!(
        db.meal_sync_status(&id, "2026-01-11").unwrap()["scopeAvailable"],
        true
    );
    let queued = db
        .enqueue_meal_sync(&id, &actor, "first:ñ", "2026-01-11")
        .unwrap();
    assert_eq!(queued["jobs"].as_array().unwrap().len(), 2);
    let row = db.job(s(&queued["jobs"][1], "id"), Some(&id)).unwrap();
    let request: Value = serde_json::from_str(s(&row, "request")).unwrap();
    assert_eq!(request["station"], "DOT4");
    assert_eq!(request["dspAbbreviation"], "FSCL");
    assert_eq!(request["dspName"], db.get_dsp(&id).unwrap()["name"]);
    assert!(request.get("serviceAreaId").is_none());
    db.cancel_dsp(&id).unwrap();
    seed(&db, &id, "2026-01-11", 1);
    seed(&db, &id, "2026-01-11", 2);
    let replay = db
        .enqueue_meal_sync(&id, &actor, "first:ñ", "2026-01-11")
        .unwrap();
    for index in 0..2 {
        assert_eq!(queued["jobs"][index]["id"], replay["jobs"][index]["id"]);
    }
    assert_eq!(jobs(&db, &id).len(), 2);
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "first:ñ", "2026-01-12")
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
}
#[test]
fn combined_sync_reuses_tenant_scope_records_date_and_is_idempotent() {
    let (_root, db, id, actor) = fixture();
    enable(&db, &id, Provider::Paycom);
    enable(&db, &id, Provider::Cortex);
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "first", "2026-01-11")
            .unwrap_err()
            .code,
        "meal_sync_scope_required"
    );
    assert!(jobs(&db, &id).is_empty());
    seed(&db, &id, "2026-01-10", 1);
    let queued = db
        .enqueue_meal_sync(&id, &actor, "first", "2026-01-11")
        .unwrap();
    assert_eq!(queued["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(
        queued,
        db.enqueue_meal_sync(&id, &actor, "first", "2026-01-11")
            .unwrap()
    );
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "first", "2026-01-12")
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "second", "2026-01-11")
            .unwrap_err()
            .code,
        "sync_in_progress"
    );
    for job in queued["jobs"].as_array().unwrap() {
        let row = db.job(s(job, "id"), Some(&id)).unwrap();
        let request: Value = serde_json::from_str(s(&row, "request")).unwrap();
        assert_eq!(request["date"], "2026-01-11");
        if row["kind"] == "cortex.meal_breaks.collect" {
            assert_eq!(request["serviceAreaId"], "area-1");
            assert_eq!(request["timezone"], "America/Los_Angeles");
        }
    }
    let status = db.meal_sync_status(&id, "2026-01-11").unwrap();
    assert_eq!(status["paycom"]["active"], true);
    assert_eq!(status["flex"]["active"], true);
    assert_eq!(status["flex"]["collectedAt"], Value::Null);
    db.cancel_dsp(&id).unwrap();
    db.jobs
        .exec(
            "UPDATE jobs SET status='failed' WHERE kind='cortex.meal_breaks.collect'",
            [],
        )
        .unwrap();
    db.jobs
        .exec(
            "UPDATE jobs SET status='succeeded' WHERE kind='paycom.collect'",
            [],
        )
        .unwrap();
    let status = db.meal_sync_status(&id, "2026-01-11").unwrap();
    assert_eq!(status["flex"]["job"]["status"], "failed");
    assert_eq!(status["paycom"]["job"]["status"], "succeeded");
    assert_eq!(
        db.meal_sync_status(&id, "2026-01-12").unwrap()["flex"]["job"],
        Value::Null
    );
}
#[test]
fn invalid_dates_missing_connections_and_capacity_never_queue_half_a_sync() {
    let (_root, db, id, actor) = fixture();
    seed(&db, &id, "2026-01-10", 1);
    enable(&db, &id, Provider::Paycom);
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "missing", "2026-01-10")
            .unwrap_err()
            .code,
        "meal_sync_flex_required"
    );
    enable(&db, &id, Provider::Cortex);
    for date in ["2026-02-30", "2099-01-01", "2026-1-10", "1999-12-31"] {
        assert_eq!(
            db.enqueue_meal_sync(&id, &actor, "invalid", date)
                .unwrap_err()
                .code,
            "invalid_date"
        );
    }
    assert!(jobs(&db, &id).is_empty());
    for i in 2..=5 {
        seed(&db, &id, "2026-01-10", i);
    }
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "full", "2026-01-10")
            .unwrap_err()
            .code,
        "queue_full"
    );
    assert!(jobs(&db, &id).is_empty());
    assert_eq!(
        db.enqueue_paycom_date(&id, Some(&actor), "day", "2026-01-09")
            .unwrap()["kind"],
        "paycom.collect"
    );
    assert_eq!(
        db.meal_sync_status(&id, "2026-01-10").unwrap()["paycom"]["active"],
        true
    );
    assert_eq!(
        json!({"date":"2026-01-09"}),
        serde_json::from_str::<Value>(s(
            &db.job(s(&jobs(&db, &id)[0], "id"), None).unwrap(),
            "request"
        ))
        .unwrap()
    );
}

#[test]
fn successful_station_does_not_hide_a_failed_station_in_the_same_sync() {
    let (_root, db, id, actor) = fixture();
    enable(&db, &id, Provider::Paycom);
    enable(&db, &id, Provider::Cortex);
    seed(&db, &id, "2026-01-10", 1);
    seed(&db, &id, "2026-01-10", 2);
    let result = db
        .enqueue_meal_sync(&id, &actor, "stations", "2026-01-11")
        .unwrap();
    db.jobs
        .exec("UPDATE jobs SET status='succeeded'", [])
        .unwrap();
    db.jobs
        .exec(
            "UPDATE jobs SET status='failed',created_at='2026-01-01' WHERE id=?",
            [s(&result["jobs"][1], "id")],
        )
        .unwrap();
    let status = db.meal_sync_status(&id, "2026-01-11").unwrap();
    assert_eq!(status["flex"]["job"]["status"], "failed");
    assert_eq!(status["flex"]["active"], false);
    assert_eq!(status["paycom"]["job"]["status"], "succeeded");
}

#[test]
fn status_reads_allow_a_viewer_date_ahead_of_the_dsp_but_collection_does_not() {
    let (_root, db, id, actor) = fixture();
    let tomorrow = (chrono::Utc::now().date_naive() + chrono::Duration::days(1)).to_string();
    assert_eq!(
        db.meal_sync_status(&id, &tomorrow).unwrap()["date"],
        tomorrow
    );
    assert_eq!(
        db.enqueue_meal_sync(&id, &actor, "future", &tomorrow)
            .unwrap_err()
            .code,
        "invalid_date"
    );
    assert_eq!(
        db.meal_sync_status(&id, "2026-02-30").unwrap_err().code,
        "invalid_date"
    );
}
