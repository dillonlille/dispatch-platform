use dispatch_backend::core::{
    collectors::Provider,
    config::Config,
    db::{Store, now, s},
    meals::{self, Coverage, Meal, Scope},
    operations,
};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
fn store() -> (tempfile::TempDir, Store, String) {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut c = Config::load().unwrap();
    c.root = root.path().into();
    c.fixture = true;
    c.development = true;
    c.environment = "preview".into();
    let db = Store::initialize(c).unwrap();
    let b = operations::bootstrap(
        &db,
        "owner@example.test",
        "Test",
        "Owner",
        "test-password-long",
    )
    .unwrap();
    let id = s(&b["dsp"], "id").to_owned();
    (root, db, id)
}
fn scope() -> Scope {
    Scope {
        date: "2026-01-10".into(),
        station: "DOT4".into(),
        service_area_id: "area-1".into(),
        provider: "provider-1".into(),
        timezone: "America/Los_Angeles".into(),
    }
}
#[test]
fn four_timestamps_multiple_meals_midnight_and_unknown_boundaries_survive_round_trip() {
    let (_root, db, id) = store();
    let scope = scope();
    let mut c = meals::fixture(&scope);
    let route = &mut c.itineraries[0];
    let midnight = chrono::DateTime::parse_from_rfc3339("2026-01-11T07:50:00Z")
        .unwrap()
        .timestamp_millis();
    route.meals.push(Meal {
        id: "meal-2".into(),
        start: midnight,
        end: Some(midnight + 1800000),
        last_delivery: Some(midnight - 120000),
        first_delivery: Some(midnight + 1980000),
    });
    let p = db.publish_meals(&id, "job-first", &c, &scope).unwrap();
    let data = db.collector(&id, Provider::Cortex).unwrap();
    let row=data.one("SELECT last_delivery_at,started_at,ended_at,first_delivery_at FROM meal_records WHERE meal_id='meal-2'",[]).unwrap().unwrap();
    assert_eq!(
        row,
        json!({"last_delivery_at":"2026-01-11T07:48:00.000Z","started_at":"2026-01-11T07:50:00.000Z","ended_at":"2026-01-11T08:20:00.000Z","first_delivery_at":"2026-01-11T08:23:00.000Z"})
    );
    for table in ["meal_delivery_events", "meal_breaks"] {
        assert_eq!(
            data.one(&format!("SELECT count(*) n FROM {table}"), [])
                .unwrap()
                .unwrap()["n"],
            0
        );
    }
    assert_eq!(
        db.publish_meals(&id, "job-first", &c, &scope).unwrap()["id"],
        p["id"]
    );
    c.itineraries[0].delivery_coverage = Coverage::Unavailable;
    for meal in &mut c.itineraries[0].meals {
        meal.last_delivery = None;
        meal.first_delivery = None;
    }
    c.itineraries[0].meals.push(Meal {
        id: "open-meal".into(),
        start: midnight + 48 * 3600000,
        end: None,
        last_delivery: None,
        first_delivery: None,
    });
    // A timestamp beyond the bounded operating-day window is rejected.
    assert_eq!(
        db.publish_meals(&id, "job-bad", &c, &scope)
            .unwrap_err()
            .code,
        "invalid_cortex_meal"
    );
    c.itineraries[0].meals.pop();
    db.publish_meals(&id, "job-second", &c, &scope).unwrap();
    let row=data.one("SELECT b.before_status,b.after_status,b.last_delivery_at,b.first_delivery_at FROM meal_records b JOIN meal_publications p ON p.id=b.publication_id WHERE p.active=1 LIMIT 1",[]).unwrap().unwrap();
    assert_eq!(
        row,
        json!({"before_status":"unavailable","after_status":"unavailable","last_delivery_at":null,"first_delivery_at":null})
    );
    assert_eq!(
        data.one("SELECT count(*) n FROM meal_publications", [])
            .unwrap()
            .unwrap()["n"],
        2
    );
}
#[test]
fn invalid_or_shrinking_refresh_preserves_publication_and_retention_is_bounded() {
    let (_root, db, id) = store();
    let scope = scope();
    let c = meals::fixture(&scope);
    db.publish_meals(&id, "original", &c, &scope).unwrap();
    let before = db.meal_publications(&id, &scope.date).unwrap();
    let mut invalid = c.clone();
    invalid.itineraries[0].meals[0].last_delivery = Some(invalid.itineraries[0].meals[0].start + 1);
    assert_eq!(
        db.publish_meals(&id, "duplicate", &invalid, &scope)
            .unwrap_err()
            .code,
        "invalid_cortex_delivery_boundary"
    );
    invalid = c.clone();
    invalid.itineraries.clear();
    assert_eq!(
        db.publish_meals(&id, "shrink", &invalid, &scope)
            .unwrap_err()
            .code,
        "cortex_membership_regressed"
    );
    invalid = c.clone();
    invalid.scope.provider = "another-provider".into();
    assert_eq!(
        db.publish_meals(&id, "wrong", &invalid, &scope)
            .unwrap_err()
            .code,
        "cortex_scope_mismatch"
    );
    assert_eq!(before, db.meal_publications(&id, &scope.date).unwrap());
    for i in 0..8 {
        let mut next = c.clone();
        next.finished_at = now();
        db.publish_meals(&id, &format!("refresh-{i}"), &next, &scope)
            .unwrap();
    }
    let data = db.collector(&id, Provider::Cortex).unwrap();
    assert_eq!(
        data.one("SELECT count(*) n FROM meal_publications", [])
            .unwrap()
            .unwrap()["n"],
        5
    );
    assert!(data.all("PRAGMA foreign_key_check", []).unwrap().is_empty());
}
#[test]
fn provider_jobs_bind_request_identity_and_connection_revision() {
    let (_root, db, id) = store();
    let scope = scope();
    db.collector(&id, Provider::Cortex)
        .unwrap()
        .exec("UPDATE connections SET enabled=1", [])
        .unwrap();
    let job = db.enqueue_meals(&id, None, "request", &scope).unwrap();
    assert_eq!(job["kind"], "cortex.meal_breaks.collect");
    assert_eq!(
        db.enqueue_meals(&id, None, "request", &scope).unwrap()["id"],
        job["id"]
    );
    let mut other = scope.clone();
    other.date = "2026-01-11".into();
    assert_eq!(
        db.enqueue_meals(&id, None, "request", &other)
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    db.claim("worker", |_, _| true).unwrap().unwrap();
    db.guard_job(s(&job, "id"), "worker").unwrap();
    db.collector(&id, Provider::Cortex)
        .unwrap()
        .exec("UPDATE connections SET revision=revision+1", [])
        .unwrap();
    assert_eq!(
        db.guard_job(s(&job, "id"), "worker").unwrap_err().code,
        "connection_changed"
    );
}

#[test]
fn migration_minimizes_all_history_and_legacy_runtime_publications() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    db.execute_batch(include_str!("../src/core/collectors/cortexMeals.sql"))
        .unwrap();
    let legacy_publish = |id: &str| {
        db.execute("INSERT INTO meal_publications VALUES (?1,?1,'2026-01-10','DOT4','area','provider','UTC','2026-01-10T20:00:00.000Z','2026-01-10T20:00:00.000Z',0,1,1,1,2)",[id]).unwrap();
        db.execute("INSERT INTO meal_itineraries VALUES (?1,'route','driver','Driver','R1','2026-01-10T20:00:00.000Z',1,'complete','recorded')",[id]).unwrap();
        for (event, time) in [
            ("irrelevant", "10:00"),
            ("before", "12:00"),
            ("after", "13:00"),
        ] {
            db.execute(
                "INSERT INTO meal_delivery_events VALUES (?1,'route',?2,'stop',?3)",
                rusqlite::params![id, event, format!("2026-01-10T{time}:00.000Z")],
            )
            .unwrap();
        }
        db.execute("INSERT INTO meal_breaks VALUES (?1,'route','meal','2026-01-10T12:05:00.000Z','2026-01-10T12:35:00.000Z',1800,'before','after',300,1500,'verified','verified')",[id]).unwrap();
    };
    legacy_publish("old-inactive");
    legacy_publish("old-active");
    db.execute(
        "UPDATE meal_publications SET active=1 WHERE id='old-active'",
        [],
    )
    .unwrap();
    db.execute_batch(include_str!("../src/core/collectors/cortexMealRecords.sql"))
        .unwrap();
    legacy_publish("rollback-runtime");
    db.execute("UPDATE meal_publications SET active=0", [])
        .unwrap();
    db.execute(
        "UPDATE meal_publications SET active=1 WHERE id='rollback-runtime'",
        [],
    )
    .unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM meal_records WHERE last_delivery_at='2026-01-10T12:00:00.000Z' AND first_delivery_at='2026-01-10T13:00:00.000Z'",[],|r|r.get::<_,i64>(0)).unwrap(),3);
    for table in ["meal_delivery_events", "meal_breaks"] {
        assert_eq!(
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    db.execute("DELETE FROM meal_publications WHERE id='old-inactive'", [])
        .unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM meal_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(
        !db.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap()
    );
}
