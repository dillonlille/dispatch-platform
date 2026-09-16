use dispatch_backend::core::{
    collectors::Provider,
    config::Config,
    db::{Store, now, s},
    meals::{self, Coverage, Delivery, Meal, Scope},
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
fn multiple_meals_event_identity_midnight_and_unknown_gaps_survive_database_round_trip() {
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
    });
    route.deliveries.extend([
        Delivery {
            id: "late-before".into(),
            stop_id: "stop-3".into(),
            time: midnight - 120000,
        },
        Delivery {
            id: "late-after".into(),
            stop_id: "stop-4".into(),
            time: midnight + 1980000,
        },
        Delivery {
            id: "same-minute".into(),
            stop_id: "stop-4".into(),
            time: midnight + 1981000,
        },
    ]);
    let p = db.publish_meals(&id, "job-first", &c, &scope).unwrap();
    let data = db.collector(&id, Provider::Cortex).unwrap();
    let row=data.one("SELECT duration_seconds,gap_before_seconds,gap_after_seconds,next_event_id FROM meal_breaks WHERE meal_id='meal-2'",[]).unwrap().unwrap();
    assert_eq!(
        row,
        json!({"duration_seconds":1800,"gap_before_seconds":120,"gap_after_seconds":180,"next_event_id":"late-after"})
    );
    assert_eq!(
        data.one("SELECT count(*) n FROM meal_delivery_events", [])
            .unwrap()
            .unwrap()["n"],
        5
    );
    assert_eq!(
        db.publish_meals(&id, "job-first", &c, &scope).unwrap()["id"],
        p["id"]
    );
    c.itineraries[0].delivery_coverage = Coverage::Unavailable;
    c.itineraries[0].meals.push(Meal {
        id: "open-meal".into(),
        start: midnight + 48 * 3600000,
        end: None,
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
    let row=data.one("SELECT b.before_status,b.after_status,b.gap_before_seconds,b.gap_after_seconds FROM meal_breaks b JOIN meal_publications p ON p.id=b.publication_id WHERE p.active=1 LIMIT 1",[]).unwrap().unwrap();
    assert_eq!(
        row,
        json!({"before_status":"unavailable","after_status":"unavailable","gap_before_seconds":null,"gap_after_seconds":null})
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
    let duplicate = invalid.itineraries[0].deliveries[0].clone();
    invalid.itineraries[0].deliveries.push(duplicate);
    assert_eq!(
        db.publish_meals(&id, "duplicate", &invalid, &scope)
            .unwrap_err()
            .code,
        "invalid_cortex_delivery"
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
