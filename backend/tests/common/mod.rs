//! The store every integration test starts from. Each test file is its own crate and
//! uses a different part of this module.
#![allow(dead_code)]
use dispatch_backend::{
    config::Config,
    db::{self, Store, s},
    operations,
};
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;

/// An empty preview platform in a private temporary directory.
///
/// `Config` has no test constructor, so this is the one place that reads the process
/// environment; everything a test relies on is overridden here.
pub fn store() -> (tempfile::TempDir, Store) {
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

/// A platform with its first owner, `owner@example.test`, and the id of their empty DSP.
pub fn bootstrapped() -> (tempfile::TempDir, Store, String) {
    let (root, db) = store();
    let bootstrap = operations::bootstrap(
        &db,
        "owner@example.test",
        "Test",
        "Owner",
        "test-password-long",
    )
    .unwrap();
    let id = s(&bootstrap["dsp"], "id").to_owned();
    (root, db, id)
}

/// A platform holding the development fixtures: Northline Logistics, its owner and a member.
pub fn seeded() -> (tempfile::TempDir, Store) {
    let (root, db) = store();
    operations::seed(&db).unwrap();
    (root, db)
}

/// The newest audit events the platform (`None`) or one DSP may see.
pub fn audits(db: &Store, dsp: Option<&str>) -> dispatch_backend::Result<Value> {
    let mut page = db
        .audit_page(&db::AuditQuery {
            dsp,
            limit: 200,
            ..db::AuditQuery::default()
        })
        .map(|value| serde_json::to_value(value).unwrap())?;
    Ok(page["events"].take())
}
