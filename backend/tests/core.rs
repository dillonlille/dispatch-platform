use dispatch_backend::core::{
    browsers::egress,
    config::Config,
    crypto,
    db::{self, Store, s},
    jobs, operations, workforce,
};
use serde_json::json;
use std::os::unix::fs::{PermissionsExt, symlink};
fn store() -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = Config::load().unwrap();
    config.root = root.path().to_owned();
    config.development = true;
    config.fixture = true;
    config.environment = "preview".into();
    config.standalone = true;
    let store = Store::initialize(config).unwrap();
    (root, store)
}
#[test]
fn startup_removes_owned_browseros_runs_and_rejects_unknown_entries() {
    let (_root, db) = store();
    let runs = db::private_dir(&db.config.environment_root().join("browser-runs")).unwrap();
    for prefix in ["run", "browseros"] {
        db::private_dir(&runs.join(crypto::id(prefix).unwrap())).unwrap();
    }
    operations::clean_browser_runs(&db.config).unwrap();
    assert_eq!(std::fs::read_dir(&runs).unwrap().count(), 0);
    let unknown = runs.join("unrecognized");
    db::private_dir(&unknown).unwrap();
    assert_eq!(
        operations::clean_browser_runs(&db.config).unwrap_err().code,
        "unexpected_browser_run"
    );
    assert!(unknown.exists());
}
#[test]
fn authenticated_encryption_binds_every_secret_to_its_tenant() {
    let key = crypto::random::<32>().unwrap();
    let value =
        json!({"password":"private","securityAnswers":["00123","two","three","four","five"]});
    let encrypted = crypto::encrypt(&key, "dsp-one", &value).unwrap();
    assert_eq!(crypto::decrypt(&key, "dsp-one", &encrypted).unwrap(), value);
    assert!(crypto::decrypt(&key, "dsp-two", &encrypted).is_err());
    assert!(crypto::decrypt(&key, "dsp-one", &format!("{encrypted}x")).is_err());
    assert!(!encrypted.contains("private"));
    let encoded = crypto::hash_password("a-strong-test-password").unwrap();
    assert!(crypto::check_password("a-strong-test-password", &encoded));
    assert!(!crypto::check_password("wrong", &encoded));
}
#[test]
fn publication_is_atomic_and_keeps_the_last_successful_dataset() {
    let (_root, db) = store();
    let bootstrap = operations::bootstrap(
        &db,
        "owner@example.test",
        "Test",
        "Owner",
        "test-password-long",
    )
    .unwrap();
    let id = s(&bootstrap["dsp"], "id");
    let data = workforce::fixture("UTC").unwrap();
    db.publish(id, &data).unwrap();
    let before = db.employee(id, "E001").unwrap();
    let mut bad = data.clone();
    bad["employees"][1]["code"] = json!("E001");
    assert_eq!(db.publish(id, &bad).unwrap_err().code, "duplicate_employee");
    bad = data.clone();
    bad["timecards"][0]["employeeCode"] = json!("unowned");
    assert_eq!(
        db.publish(id, &bad).unwrap_err().code,
        "timecard_identity_mismatch"
    );
    bad = data.clone();
    bad["timecards"][0]["hours"] = json!(49);
    assert!(db.publish(id, &bad).is_err());
    bad = data.clone();
    bad["timecards"][0]["date"] = json!("2026-02-30");
    assert!(db.publish(id, &bad).is_err());
    assert_eq!(db.employee(id, "E001").unwrap(), before);
    let mut later = data.clone();
    later["collectedAt"] = json!("2099-01-01T00:00:00.000Z");
    later["employees"].as_array_mut().unwrap().remove(0);
    later["timecards"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["employeeCode"] != "E001");
    db.publish(id, &later).unwrap();
    assert_eq!(db.employees(id, "", 0, 100, false).unwrap()["total"], 11);
    assert_eq!(db.employee(id, "E001").unwrap(), before);
}
#[test]
fn queue_limits_and_authority_are_checked_again_before_publication() {
    let (_root, db) = store();
    operations::seed(&db).unwrap();
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
    for i in 0..5 {
        db.enqueue(id, Some(actor), &format!("request-{i}"))
            .unwrap();
    }
    assert_eq!(
        db.enqueue(id, Some(actor), "overflow").unwrap_err().status,
        429
    );
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
    db.collector(id, dispatch_backend::core::collectors::Provider::Paycom)
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
fn settings_reject_unknown_fields_and_preserve_empty_driver_selection() {
    let (_root, db) = store();
    operations::seed(&db).unwrap();
    let dsp = db
        .platform
        .one("SELECT id FROM dsps WHERE permanent=1", [])
        .unwrap()
        .unwrap();
    let id = s(&dsp, "id");
    let actor = db
        .platform
        .one("SELECT id FROM users WHERE platform_owner=1", [])
        .unwrap()
        .unwrap();
    let mut values = db.preferences(id).unwrap()["values"].clone();
    values["driver_departments"] = json!([]);
    values["automatic_sync"] = json!(false);
    db.save_preferences(id, s(&actor, "id"), 0, &values)
        .unwrap();
    let day = workforce::fixture("UTC").unwrap()["to"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        db.daily(id, &day, "name", false).unwrap()["rows"],
        json!([])
    );
    assert_eq!(db.employees(id, "", 0, 100, false).unwrap()["total"], 12);
    values["unknown"] = json!(true);
    assert!(
        db.save_preferences(id, s(&actor, "id"), 1, &values)
            .is_err()
    );
}
#[test]
fn schedule_handles_dst_gaps_and_repeated_minutes() {
    let parse = |s: &str| {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(
        jobs::next_occurrence("02:30", "America/Chicago", parse("2026-03-08T07:59:00Z")).unwrap(),
        "2026-03-09T07:30:00.000Z"
    );
    assert_eq!(
        jobs::next_occurrence("01:30", "America/Chicago", parse("2026-11-01T06:30:00Z")).unwrap(),
        "2026-11-01T07:30:00.000Z"
    );
    assert!(jobs::next_occurrence("25:99", "UTC", 0).is_err());
}
#[test]
fn private_storage_rejects_links_and_world_readable_files() {
    let (root, db) = store();
    let first = root.path().join("private");
    db::write_private(&first, b"private").unwrap();
    let link = root.path().join("link");
    symlink(&first, &link).unwrap();
    assert!(db::private_file(&link, false).is_err());
    let hard = root.path().join("hard");
    std::fs::hard_link(&first, &hard).unwrap();
    assert!(db::private_file(&first, false).is_err());
    std::fs::remove_file(hard).unwrap();
    std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(db::private_file(&first, false).is_err());
    assert!(db.area("../escape", "data").is_err());
}
#[test]
fn egress_rejects_private_and_lookalike_destinations() {
    for address in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "198.18.0.1",
        "::1",
        "::ffff:8.8.8.8",
    ] {
        assert!(
            !egress::public_address(address.parse().unwrap()),
            "{address}"
        );
    }
    assert!(egress::public_address("8.8.8.8".parse().unwrap()));
    assert!(egress::allowed_host("time-and-attendance.paycomonline.net"));
    for host in [
        "evilpaycomonline.net",
        "paycomonline.net.evil.test",
        "localhost",
        "127.0.0.1",
    ] {
        assert!(!egress::allowed_host(host));
    }
}

#[test]
fn legacy_account_database_is_rejected_without_changing_its_schema() {
    let (_root, db) = store();
    let config = db.config.clone();
    db.platform
        .0
        .pragma_update(None, "user_version", 2)
        .unwrap();
    drop(db);
    let error = Store::initialize(config.clone()).err().unwrap();
    assert_eq!(error.code, "incompatible_database");
    let old = rusqlite::Connection::open(config.platform().join("accounts.sqlite")).unwrap();
    assert_eq!(
        old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn essential_background_failure_stops_readiness_and_normal_shutdown_is_clean() {
    use dispatch_backend::core::{Error, supervise};
    let (stop, receiver) = tokio::sync::watch::channel(false);
    assert!(
        supervise(async { Err(Error::new("scheduler_failed", 500)) }, stop)
            .await
            .is_err()
    );
    assert!(*receiver.borrow());
    let (stop, receiver) = tokio::sync::watch::channel(false);
    assert!(
        supervise(async { panic!("fixture panic") }, stop)
            .await
            .is_err()
    );
    assert!(*receiver.borrow());
    let (stop, _) = tokio::sync::watch::channel(true);
    assert!(supervise(async { Ok(()) }, stop).await.is_ok());
}

#[test]
fn cortex_network_policy_keeps_provider_hosts_separate() {
    use dispatch_backend::core::browsers::egress;
    for host in [
        "logistics.amazon.com",
        "www.amazon.com",
        "m.media-amazon.com",
        "images-na.ssl-images-amazon.com",
    ] {
        assert!(egress::allowed_cortex_host(host));
        assert!(!egress::allowed_host(host));
    }
    for host in [
        "www.paycomonline.net",
        "amazon.com.evil.test",
        "evilamazon.com",
        "evilmedia-amazon.com",
        "127.0.0.1",
        "metadata.google.internal",
    ] {
        assert!(!egress::allowed_cortex_host(host));
    }
}
