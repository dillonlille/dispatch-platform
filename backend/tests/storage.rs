mod common;
use common::store;
use dispatch_backend::{
    crypto,
    db::{self, Store},
    operations,
};
use serde_json::json;
use std::os::unix::fs::{PermissionsExt, symlink};

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
fn private_storage_tolerates_concurrent_sidecar_removal() {
    use std::{
        fs::OpenOptions,
        os::unix::fs::OpenOptionsExt,
        sync::atomic::{AtomicBool, Ordering},
    };
    let root = tempfile::tempdir().unwrap();
    let sidecar = root.path().join("database.sqlite-wal");
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !stop.load(Ordering::Relaxed) {
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&sidecar)
                    .unwrap();
                std::fs::remove_file(&sidecar).unwrap();
                drop(file);
            }
        });
        let result = (0..100_000).try_for_each(|_| db::private_file(&sidecar, false));
        stop.store(true, Ordering::Relaxed);
        result.unwrap();
    });
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
    use dispatch_backend::{Error, supervise};
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
