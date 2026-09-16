use dispatch_backend::core::{
    collectors::Provider,
    config::Config,
    db::{Store, s},
    meals::{self, Scope},
    operations, workforce,
};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

fn store() -> (tempfile::TempDir, Store, String) {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = Config::load().unwrap();
    config.root = root.path().into();
    config.fixture = true;
    config.development = true;
    config.environment = "preview".into();
    let store = Store::initialize(config).unwrap();
    let bootstrap = operations::bootstrap(
        &store,
        "owner@example.test",
        "Test",
        "Owner",
        "test-password-long",
    )
    .unwrap();
    let id = s(&bootstrap["dsp"], "id").to_owned();
    (root, store, id)
}
fn actor(db: &Store) -> String {
    s(
        &db.platform
            .one("SELECT id FROM users LIMIT 1", [])
            .unwrap()
            .unwrap(),
        "id",
    )
    .to_owned()
}
fn seed(db: &Store, id: &str) -> (String, String) {
    let mut workforce = workforce::fixture("America/Los_Angeles").unwrap();
    let date = s(&workforce, "from").to_owned();
    // A same-name employee still requires an explicit identity link.
    workforce["employees"][0]["name"] = json!("Driver, Demo");
    let cards = workforce["timecards"].as_array_mut().unwrap();
    for card in cards {
        if card["employeeCode"] == "E002" {
            card["punches"] = json!([]);
        }
        if card["employeeCode"] == "E003" {
            card["punches"] =
                json!([{"in":null,"out":"12:00","hours":null,"inKind":null,"outKind":"OUT LUNCH"}]);
            card["status"] = json!("Missing punch");
        }
    }
    db.publish(id, &workforce).unwrap();
    let scope = Scope {
        date: date.clone(),
        station: "DEMO1".into(),
        service_area_id: "area-demo".into(),
        provider: "provider-demo".into(),
        timezone: "America/Los_Angeles".into(),
    };
    let mut capture = meals::fixture(&scope);
    capture.itineraries[0].driver = "Demo Driver".into();
    let transporter = capture.itineraries[0].transporter_id.clone();
    db.publish_meals(id, "job-meals", &capture, &scope).unwrap();
    (date, transporter)
}
#[test]
fn union_uses_confirmed_links_and_retains_partial_source_only_employees() {
    let (_root, db, id) = store();
    let (date, transporter) = seed(&db, &id);
    let data = db.meal_comparison(&id, &date, "UTC").unwrap();
    assert_eq!(data["timezone"], "America/Los_Angeles");
    assert_eq!(data["rows"].as_array().unwrap().len(), 12); // 11 with punches + Cortex-only
    assert_eq!(data["links"]["links"], json!([]));
    assert!(
        !data["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["paycom"]["employeeCode"] == "E002")
    );
    assert!(
        data["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["paycom"]["employeeCode"] == "E003")
    );
    db.save_employee_links(
        &id,
        &actor(&db),
        &json!({"revision":0,"changes":[{"cortexId":transporter,"paycomCode":"E001"}]}),
    )
    .unwrap();
    let data = db.meal_comparison(&id, &date, "UTC").unwrap();
    assert_eq!(data["rows"].as_array().unwrap().len(), 11);
    let linked = data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["paycom"]["employeeCode"] == "E001")
        .unwrap();
    assert_eq!(linked["cortex"].as_array().unwrap().len(), 1);
    assert!(linked["cortex"][0]["lastDelivery"].is_string());
    assert_eq!(
        db.save_employee_links(
            &id,
            &actor(&db),
            &json!({"revision":0,"changes":[{"cortexId":transporter,"paycomCode":null}]})
        )
        .unwrap_err()
        .code,
        "settings_changed_reload_before_saving"
    );
    db.save_employee_links(
        &id,
        &actor(&db),
        &json!({"revision":1,"changes":[{"cortexId":transporter,"paycomCode":"E002"}]}),
    )
    .unwrap();
    let data = db.meal_comparison(&id, &date, "UTC").unwrap();
    let linked = data["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "paycom:E002")
        .unwrap();
    assert!(linked["paycom"].is_null());
    assert_eq!(linked["cortex"].as_array().unwrap().len(), 1);
    assert_eq!(
        db.meal_comparison(&id, "2020-01-01", "UTC").unwrap()["rows"],
        json!([])
    );
    assert!(db.meal_comparison(&id, "not-a-date", "UTC").is_err());
    assert_eq!(
        db.collector(&id, Provider::Cortex)
            .unwrap()
            .one("SELECT count(*) n FROM meal_delivery_events", [])
            .unwrap()
            .unwrap()["n"],
        0
    );
}
#[test]
fn link_changes_are_atomic_unique_scoped_and_rollback_readable() {
    let (_root, db, id) = store();
    let (_, transporter) = seed(&db, &id);
    let invalid = json!({"revision":0,"changes":[{"cortexId":transporter,"paycomCode":"E001"},{"cortexId":"unknown","paycomCode":"E002"}]});
    assert_eq!(
        db.save_employee_links(&id, &actor(&db), &invalid)
            .unwrap_err()
            .code,
        "employee_link_source_missing"
    );
    assert_eq!(db.employee_links(&id).unwrap()["revision"], 0);
    db.collector(&id, Provider::Cortex).unwrap().exec(
        "INSERT INTO meal_itineraries SELECT publication_id,itinerary_id||'-2',transporter_id||'-2',driver_name,route_code,observed_at,route_complete,delivery_coverage,meal_state FROM meal_itineraries",[]
    ).unwrap();
    assert_eq!(
        db.save_employee_links(
            &id,
            &actor(&db),
            &json!({"revision":0,"changes":[
                {"cortexId":transporter,"paycomCode":"E001"},
                {"cortexId":format!("{transporter}-2"),"paycomCode":"E001"}
            ]})
        )
        .unwrap_err()
        .code,
        "employee_already_linked"
    );
    assert_eq!(db.employee_links(&id).unwrap()["links"], json!([]));
    let user: Value = db
        .platform
        .one("SELECT id FROM users LIMIT 1", [])
        .unwrap()
        .unwrap();
    let other = db
        .create_dsp("Another DSP", "UTC", s(&user, "id"), false)
        .unwrap();
    assert!(
        db.save_employee_links(
            s(&other, "id"),
            &actor(&db),
            &json!({"revision":0,"changes":[{"cortexId":transporter,"paycomCode":"E001"}]})
        )
        .is_err()
    );
    assert_eq!(
        db.dsp(&id)
            .unwrap()
            .one("PRAGMA user_version", [])
            .unwrap()
            .unwrap()["user_version"],
        1
    );
}
#[test]
fn newer_empty_scope_suppresses_stale_meals_and_latest_paycom_period_wins() {
    let (_root, db, id) = store();
    let (date, _) = seed(&db, &id);
    let scope = Scope {
        date: date.clone(),
        station: "DEMO1".into(),
        service_area_id: "area-demo".into(),
        provider: "ALL_DRIVERS".into(),
        timezone: "America/Los_Angeles".into(),
    };
    let mut capture = meals::fixture(&scope);
    capture.itineraries[0].meals.clear();
    db.publish_meals(&id, "new-scope", &capture, &scope)
        .unwrap();
    db.collector(&id,Provider::Cortex).unwrap().exec("UPDATE meal_publications SET collected_at='2099-01-01T00:00:00.000Z' WHERE job_id='new-scope'",[]).unwrap();
    let data = db.meal_comparison(&id, &date, "UTC").unwrap();
    assert_eq!(data["rows"].as_array().unwrap().len(), 11);
    assert!(
        data["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["cortex"] == json!([]))
    );
    let mut newer = workforce::fixture("America/Los_Angeles").unwrap();
    newer["collectedAt"] = json!("2099-01-01T00:00:00Z");
    newer["timecards"] = json!([]);
    db.publish(&id, &newer).unwrap();
    assert_eq!(
        db.meal_comparison(&id, &date, "UTC").unwrap()["rows"],
        json!([])
    );
}
