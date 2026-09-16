//! Collector-owned databases. Provider identities and paths are compiled code,
//! never user-controlled paths. See docs/COLLECTORS.md for the extension contract.
use super::{
    Result,
    db::{self, Db, DspLease, Store, s},
    ensure,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

// The dual-layout reader shipped in 9a63ef1 before migration was enabled.
// The immediately previous Dev artifact can read and write the split layout.
pub(crate) const MIGRATE_ON_START: bool = true;
const LAYOUT: &str = "storage.collectors";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Paycom,
    Cortex,
}
impl Provider {
    pub const ALL: &[Self] = &[Self::Paycom, Self::Cortex];
    pub fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|p| p.id() == value)
            .ok_or_else(|| super::Error::new("not_found", 404))
    }
    pub fn key(self, dsp: &str) -> String {
        format!("{dsp}:{}", self.id())
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::Paycom => "paycom",
            Self::Cortex => "cortex",
        }
    }
    pub fn job_kind(self) -> Option<&'static str> {
        match self {
            Self::Paycom => Some("paycom.collect"),
            Self::Cortex => Some("cortex.meal_breaks.collect"),
        }
    }
    pub fn from_job_kind(kind: &str) -> Result<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|p| p.job_kind() == Some(kind))
            .ok_or_else(|| super::Error::new("unsupported_collector", 409))
    }
    fn schema(self) -> &'static str {
        match self {
            Self::Paycom => include_str!("paycom.sql"),
            Self::Cortex => include_str!("cortex.sql"),
        }
    }
    fn version(self) -> i64 {
        match self {
            Self::Paycom | Self::Cortex => 1,
        }
    }
    fn relative_path(self) -> PathBuf {
        Path::new(self.id()).join(format!("{}.sqlite", self.id()))
    }
    fn browser_entries(self) -> &'static [&'static str] {
        match self {
            Self::Paycom => &[
                "paycom", // Retired profile retained on existing hosts.
                "paycom-browseros",
                "paycom-attempt.json",
                "paycom-diagnostics.json",
                ".paycom-browseros.browseros.lock",
            ],
            Self::Cortex => &[
                "cortex-browseros",
                "cortex-attempt.json",
                ".cortex-browseros.browseros.lock",
            ],
        }
    }
}

fn split_layout(db: &Db) -> Result<bool> {
    let layout = db.setting(LAYOUT, Value::Null)?;
    ensure(
        layout.is_null() || layout == json!(1),
        "unsupported_storage_layout",
        503,
    )?;
    Ok(!layout.is_null())
}
fn identity(db: &Db, id: &str, provider: Provider) -> Result<()> {
    let rows = db.all("SELECT dsp_id,provider,source FROM storage_identity", [])?;
    ensure(
        rows.len() == 1 && s(&rows[0], "dsp_id") == id && s(&rows[0], "provider") == provider.id(),
        "collector_storage_identity_mismatch",
        503,
    )
}

/// Operator/benchmark read-only path resolution also honors the authoritative
/// layout marker; file existence alone must never select a partial migration.
pub fn database_path(dsp_root: &Path, provider: Provider) -> Result<PathBuf> {
    let id = dsp_root.file_name().and_then(|s| s.to_str()).unwrap_or("");
    ensure(db::identifier(id, "dsp_"), "invalid_dsp_id", 400)?;
    let core = dsp_root.join("data/dispatch.sqlite");
    db::private_file(&core, false)?;
    let connection =
        rusqlite::Connection::open_with_flags(&core, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let split = split_layout(&Db(connection))?;
    let path = if split {
        dsp_root.join("data").join(provider.relative_path())
    } else {
        ensure(
            provider == Provider::Paycom,
            "collector_not_initialized",
            409,
        )?;
        core
    };
    db::private_file(&path, false)?;
    Ok(path)
}

impl Store {
    /// Credential changes reset only this collector's sessions. Call after its
    /// browser worker closes; other collectors' profiles must survive unchanged.
    pub(crate) fn clear_collector_browser_state(&self, id: &str, provider: Provider) -> Result<()> {
        let browsers = self.area(id, "state")?.join("browsers");
        if !browsers.try_exists()? {
            return Ok(());
        }
        db::private_dir(&browsers)?;
        for entry in provider.browser_entries() {
            let path = browsers.join(entry);
            match std::fs::symlink_metadata(&path) {
                Ok(stat) if stat.is_dir() => {
                    db::private_dir(&path)?;
                    std::fs::remove_dir_all(path)?;
                }
                Ok(_) => {
                    db::private_file(&path, false)?;
                    std::fs::remove_file(path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
    pub fn collector(&self, id: &str, provider: Provider) -> Result<DspLease<'_>> {
        if !split_layout(&*self.dsp(id)?)? {
            // Legacy layout only ever held Paycom data.
            ensure(
                provider == Provider::Paycom,
                "collector_not_initialized",
                409,
            )?;
            return self.dsp(id);
        }
        let path = self.area(id, "data")?.join(provider.relative_path());
        let db = self.cached_database(&path, provider.version())?;
        identity(&db, id, provider)?;
        Ok(db)
    }

    // Called only during startup/provisioning under the platform lock, before
    // serving requests. The source remains authoritative until its final commit.
    pub(crate) fn migrate_collector_storage(&self, id: &str) -> Result<()> {
        let core = self.dsp(id)?;
        if split_layout(&core)? {
            self.collector(id, Provider::Paycom)?;
            return self.initialize_cortex(id);
        }
        self.copy_legacy_paycom(id)?;
        core.transaction(|| {
            core.0.execute_batch("DROP TABLE timecards; DROP TABLE employees; DROP TABLE publications; DROP TABLE schedules; DROP TABLE connections;
                DELETE FROM settings WHERE key GLOB 'paycom.*';")?;
            core.set(LAYOUT, &json!(1))
        })?;
        self.initialize_cortex(id)
    }

    // New provider storage is additive and initialized before serving traffic.
    // A core marker distinguishes first installation from missing/lost state.
    fn initialize_cortex(&self, id: &str) -> Result<()> {
        let core = self.dsp(id)?;
        let marker = core.setting("storage.cortex", Value::Null)?;
        if marker == json!(1) {
            self.collector(id, Provider::Cortex)?;
            return self.initialize_cortex_meals(id);
        }
        ensure(marker.is_null(), "unsupported_storage_layout", 503)?;
        let provider = Provider::Cortex;
        let data = self.area(id, "data")?;
        db::private_dir(&data.join(provider.id()))?;
        let schema = format!(
            "{}\nINSERT INTO storage_identity VALUES ('{}','cortex','cortex-v1');\nINSERT INTO connections(provider,updated_at) VALUES ('cortex','{}');",
            provider.schema(),
            id,
            db::iso()
        );
        let target = Db::open(
            &data.join(provider.relative_path()),
            &schema,
            provider.version(),
            true,
        )?;
        identity(&target, id, provider)?;
        ensure(
            target
                .one(
                    "SELECT provider FROM connections WHERE provider='cortex'",
                    [],
                )?
                .is_some(),
            "collector_storage_invalid",
            503,
        )?;
        core.set("storage.cortex", &json!(1))?;
        self.initialize_cortex_meals(id)
    }

    fn initialize_cortex_meals(&self, id: &str) -> Result<()> {
        let db = self.collector(id, Provider::Cortex)?;
        if db
            .one(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='meal_schema'",
                [],
            )?
            .is_none()
        {
            db.transaction(|| {
                db.0.execute_batch(include_str!("cortexMeals.sql"))?;
                Ok(())
            })?;
        }
        ensure(
            db.all("SELECT version FROM meal_schema", [])? == vec![json!({"version":1})],
            "unsupported_cortex_schema",
            503,
        )?;
        // Missing initialized feature tables fail closed, rather than recreating lost data.
        for table in [
            "meal_publications",
            "meal_itineraries",
            "meal_delivery_events",
            "meal_breaks",
        ] {
            db.one(&format!("SELECT count(*) FROM {table} WHERE 0"), [])?;
        }
        if db
            .one(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='meal_record_schema'",
                [],
            )?
            .is_none()
        {
            db.transaction(|| {
                db.0.execute_batch(include_str!("cortexMealRecords.sql"))?;
                Ok(())
            })?;
        }
        ensure(
            db.all("SELECT version FROM meal_record_schema", [])? == vec![json!({"version":1})]
                && db.one("SELECT name FROM sqlite_master WHERE type='trigger' AND name='minimize_legacy_meal_publication'", [])?.is_some(),
            "unsupported_cortex_schema",
            503,
        )?;
        db.one("SELECT count(*) FROM meal_records WHERE 0", [])?;
        Ok(())
    }

    fn copy_legacy_paycom(&self, id: &str) -> Result<()> {
        let provider = Provider::Paycom;
        let data = self.area(id, "data")?;
        db::private_dir(&data.join(provider.id()))?;
        let path = data.join(provider.relative_path());
        // Validated random DSP IDs and compiled provider IDs are safe SQL literals.
        // The identity and schema are installed in the same SQLite transaction.
        let schema = format!(
            "{}\nINSERT INTO storage_identity VALUES ('{}','{}','dispatch-v1');",
            provider.schema(),
            id,
            provider.id()
        );
        let target = Db::open(&path, &schema, provider.version(), true)?;
        identity(&target, id, provider)?;
        ensure(
            target
                .one("SELECT source FROM storage_identity", [])?
                .is_some_and(|v| s(&v, "source") == "dispatch-v1"),
            "collector_migration_conflict",
            503,
        )?;
        let source = data.join("dispatch.sqlite");
        db::private_file(&source, false)?;
        target.exec(
            "ATTACH DATABASE ? AS legacy",
            [source.to_string_lossy().as_ref()],
        )?;
        target.transaction(|| {
            // If interrupted before the source commit, re-copy the current legacy
            // data, including any writes made by the previous build after rollback.
            target.0.execute_batch("DELETE FROM timecards; DELETE FROM employees; DELETE FROM publications;
                DELETE FROM schedules; DELETE FROM connections; DELETE FROM settings;
                INSERT INTO settings SELECT * FROM legacy.settings WHERE key GLOB 'paycom.*';
                INSERT INTO connections SELECT * FROM legacy.connections;
                INSERT INTO schedules SELECT * FROM legacy.schedules;
                INSERT INTO publications SELECT * FROM legacy.publications;
                INSERT INTO employees SELECT * FROM legacy.employees;
                INSERT INTO timecards SELECT * FROM legacy.timecards;")?;
            ensure(target.all("PRAGMA main.foreign_key_check", [])?.is_empty(), "collector_migration_invalid", 503)?;
            for table in ["connections", "schedules", "publications", "employees", "timecards"] {
                let different = target.one(&format!("SELECT EXISTS(SELECT * FROM main.{table} EXCEPT SELECT * FROM legacy.{table}) OR EXISTS(SELECT * FROM legacy.{table} EXCEPT SELECT * FROM main.{table}) AS different"), [])?.unwrap();
                ensure(different["different"] == 0, "collector_migration_invalid", 503)?;
            }
            Ok(())
        })?;
        target.exec("DETACH DATABASE legacy", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{config::Config, operations, workforce};
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn legacy() -> (tempfile::TempDir, Store, String) {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = Config::load().unwrap();
        config.root = root.path().into();
        let store = Store::initialize(config).unwrap();
        // Construct an actual pre-split DSP, independently of the activation flag.
        let id = crate::core::crypto::id("dsp").unwrap();
        store.platform.exec("INSERT INTO dsps(id,name,environment,status,timezone,created_at) VALUES (?,'Legacy','preview','active','UTC',?)", [&id, &db::iso()]).unwrap();
        store.initialize_dsp(&id).unwrap();
        let core = store.dsp(&id).unwrap();
        core.exec("INSERT INTO connections(provider,enabled,status,updated_at,revision) VALUES ('paycom',1,'ready',?,7)", [db::iso()]).unwrap();
        core.exec("INSERT INTO schedules(provider,enabled,timezone,next_run) VALUES ('paycom',1,'UTC','2099-01-01T00:00:00.000Z')", []).unwrap();
        core.set("dsp.profile", &json!({"stationCode":"TEST"}))
            .unwrap();
        core.set(
            "paycom.preferences",
            &json!({"revision":3,"values":workforce::defaults(),"history":[]}),
        )
        .unwrap();
        core.set("paycom.syncIntervalSeconds", &json!(3600))
            .unwrap();
        drop(core);
        store
            .publish(&id, &workforce::fixture("UTC").unwrap())
            .unwrap();
        (root, store, id)
    }
    fn snapshot(db: &Db) -> Value {
        let mut out = json!({});
        for table in [
            "connections",
            "schedules",
            "publications",
            "employees",
            "timecards",
        ] {
            out[table] = json!(
                db.all(&format!("SELECT * FROM {table} ORDER BY 1,2"), [])
                    .unwrap()
            );
        }
        out["settings"] = json!(
            db.all(
                "SELECT * FROM settings WHERE key GLOB 'paycom.*' ORDER BY key",
                []
            )
            .unwrap()
        );
        out
    }
    #[test]
    fn migration_preserves_all_provider_records_and_separates_core_settings() {
        let (root, store, id) = legacy();
        let before = snapshot(&store.dsp(&id).unwrap());
        store.migrate_collector_storage(&id).unwrap();
        assert_eq!(
            snapshot(&store.collector(&id, Provider::Paycom).unwrap()),
            before
        );
        let core = store.dsp(&id).unwrap();
        assert_eq!(
            core.all(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                []
            )
            .unwrap(),
            vec![json!({"name":"settings"})]
        );
        assert_eq!(
            core.setting("dsp.profile", Value::Null).unwrap()["stationCode"],
            "TEST"
        );
        assert_eq!(
            core.setting("paycom.preferences", Value::Null).unwrap(),
            Value::Null
        );
        let provider = store.collector(&id, Provider::Paycom).unwrap();
        assert_eq!(
            provider.setting("dsp.profile", Value::Null).unwrap(),
            Value::Null
        );
        drop(provider);
        drop(core);
        store.migrate_collector_storage(&id).unwrap();
        assert_eq!(
            snapshot(&store.collector(&id, Provider::Paycom).unwrap()),
            before
        );
        let path = database_path(&root.path().join("dsps").join(&id), Provider::Paycom).unwrap();
        assert!(path.ends_with("data/paycom/paycom.sqlite"));
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let reopened = Store::open(store.config.clone(), store.key.clone()).unwrap();
        assert_eq!(
            snapshot(&reopened.collector(&id, Provider::Paycom).unwrap()),
            before
        );
        let mut next = workforce::fixture("UTC").unwrap();
        next["employees"][0]["name"] = json!("New Collection");
        reopened.publish(&id, &next).unwrap();
        assert_eq!(
            reopened.employee(&id, "E001").unwrap()["employee"]["name"],
            "New Collection"
        );
    }
    #[test]
    fn interrupted_copy_retries_from_legacy_including_rollback_writes() {
        let (root, store, id) = legacy();
        store.copy_legacy_paycom(&id).unwrap();
        assert!(
            database_path(&root.path().join("dsps").join(&id), Provider::Paycom)
                .unwrap()
                .ends_with("data/dispatch.sqlite")
        );
        store
            .dsp(&id)
            .unwrap()
            .exec("UPDATE connections SET revision=42", [])
            .unwrap();
        let before = snapshot(&store.dsp(&id).unwrap());
        store.migrate_collector_storage(&id).unwrap();
        assert_eq!(
            snapshot(&store.collector(&id, Provider::Paycom).unwrap()),
            before
        );
    }
    #[test]
    fn failed_source_commit_is_recoverable_without_data_loss() {
        let (_root, store, id) = legacy();
        let core = store.dsp(&id).unwrap();
        core.0.execute_batch("CREATE TRIGGER refuse_cutover BEFORE INSERT ON settings WHEN NEW.key='storage.collectors' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        assert!(store.migrate_collector_storage(&id).is_err());
        assert!(!split_layout(&core).unwrap());
        assert!(
            core.one("SELECT * FROM timecards LIMIT 1", [])
                .unwrap()
                .is_some()
        );
        core.0.execute_batch("DROP TRIGGER refuse_cutover").unwrap();
        store.migrate_collector_storage(&id).unwrap();
        assert!(store.employee(&id, "E001").is_ok());
    }
    #[test]
    fn split_storage_survives_backup_restore_and_is_not_remigrated() {
        let (_root, store, id) = legacy();
        store.migrate_collector_storage(&id).unwrap();
        let before = snapshot(&store.collector(&id, Provider::Paycom).unwrap());
        let pulse = db::private_dir(
            &store
                .area(&id, "state")
                .unwrap()
                .join("browsers/paycom-browseros/config/pulse"),
        )
        .unwrap();
        symlink(
            "/tmp/obsolete-browser-runtime",
            pulse.join("dispatch-server-runtime"),
        )
        .unwrap();
        let external = tempfile::tempdir().unwrap();
        let backup = external.path().join("backup");
        operations::backup(&store.config, &backup).unwrap();
        let restored = external.path().join("restored");
        operations::restore(&backup, &restored).unwrap();
        assert!(
            restored
                .join("dsps")
                .join(&id)
                .join("state/browsers/paycom-browseros/config/pulse/dispatch-server-runtime")
                .symlink_metadata()
                .is_err()
        );
        // Unknown symlinks still fail closed; only known browser runtime links skip.
        symlink("/tmp/not-profile-data", pulse.join("unexpected-link")).unwrap();
        assert!(operations::backup(&store.config, &external.path().join("unsafe-backup")).is_err());
        let mut config = store.config.clone();
        config.root = restored;
        let reopened = Store::initialize(config).unwrap();
        reopened.migrate_collector_storage(&id).unwrap();
        assert_eq!(
            snapshot(&reopened.collector(&id, Provider::Paycom).unwrap()),
            before
        );
    }
    #[test]
    fn startup_migrates_suspended_dsps_and_restored_legacy_backups() {
        let (_root, store, id) = legacy();
        store
            .platform
            .exec("UPDATE dsps SET status='suspended' WHERE id=?", [&id])
            .unwrap();
        let before = snapshot(&store.dsp(&id).unwrap());
        let external = tempfile::tempdir().unwrap();
        let backup = external.path().join("legacy-backup");
        operations::backup(&store.config, &backup).unwrap();
        let restored = external.path().join("restored");
        operations::restore(&backup, &restored).unwrap();
        let mut config = store.config.clone();
        config.root = restored;
        let reopened = Store::initialize(config).unwrap();
        assert!(split_layout(&reopened.dsp(&id).unwrap()).unwrap());
        assert_eq!(
            snapshot(&reopened.collector(&id, Provider::Paycom).unwrap()),
            before
        );
        assert_eq!(reopened.get_dsp(&id).unwrap()["status"], "suspended");
    }
    #[test]
    fn cortex_storage_recovers_initialization_and_preserves_provider_identity() {
        let (_root, store, id) = legacy();
        store.migrate_collector_storage(&id).unwrap();
        let before = snapshot(&store.collector(&id, Provider::Paycom).unwrap());
        store
            .collector(&id, Provider::Cortex)
            .unwrap()
            .exec(
                "UPDATE connections SET enabled=1,status='ready',revision=8",
                [],
            )
            .unwrap();
        // A crash after creating the database but before writing the core marker.
        store
            .dsp(&id)
            .unwrap()
            .exec("DELETE FROM settings WHERE key='storage.cortex'", [])
            .unwrap();
        store.migrate_collector_storage(&id).unwrap();
        assert_eq!(
            store.connection_for(&id, Provider::Cortex).unwrap()["status"],
            "ready"
        );
        assert_eq!(
            snapshot(&store.collector(&id, Provider::Paycom).unwrap()),
            before
        );
        assert!(Provider::from_job_kind("cortex.collect").is_err());
        store
            .collector(&id, Provider::Cortex)
            .unwrap()
            .exec("UPDATE storage_identity SET dsp_id='another-dsp'", [])
            .unwrap();
        assert!(store.migrate_collector_storage(&id).is_err());
    }
    #[test]
    fn missing_initialized_cortex_database_is_not_recreated() {
        let (_root, store, id) = legacy();
        store.migrate_collector_storage(&id).unwrap();
        let path =
            database_path(&store.config.root.join("dsps").join(&id), Provider::Cortex).unwrap();
        let config = store.config.clone();
        drop(store);
        std::fs::remove_file(&path).unwrap();
        assert!(Store::initialize(config).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn resetting_paycom_browser_state_preserves_other_collectors_and_business_data() {
        let (_root, store, id) = legacy();
        store.migrate_collector_storage(&id).unwrap();
        let before = snapshot(&store.collector(&id, Provider::Paycom).unwrap());
        let browsers = store.area(&id, "state").unwrap().join("browsers");
        for name in ["paycom", "paycom-browseros", "future-collector"] {
            db::private_dir(&browsers.join(name)).unwrap();
            db::write_private(&browsers.join(name).join("session"), b"private session").unwrap();
        }
        db::write_private(&browsers.join("paycom-attempt.json"), b"{}").unwrap();
        store
            .clear_collector_browser_state(&id, Provider::Paycom)
            .unwrap();
        assert!(!browsers.join("paycom").exists());
        assert!(!browsers.join("paycom-browseros").exists());
        assert!(!browsers.join("paycom-attempt.json").exists());
        assert_eq!(
            std::fs::read(browsers.join("future-collector/session")).unwrap(),
            b"private session"
        );
        assert_eq!(
            snapshot(&store.collector(&id, Provider::Paycom).unwrap()),
            before
        );
        store
            .clear_collector_browser_state(&id, Provider::Paycom)
            .unwrap();
    }
    #[test]
    fn refuses_missing_cross_tenant_and_unsafe_storage() {
        let (root, store, id) = legacy();
        let data = root.path().join("dsps").join(&id).join("data");
        let outside = root.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, data.join("paycom")).unwrap();
        assert!(store.migrate_collector_storage(&id).is_err());
        std::fs::remove_file(data.join("paycom")).unwrap();
        store.migrate_collector_storage(&id).unwrap();
        store
            .collector(&id, Provider::Paycom)
            .unwrap()
            .exec("UPDATE storage_identity SET dsp_id='another-tenant'", [])
            .unwrap();
        assert_eq!(
            store.collector(&id, Provider::Paycom).err().unwrap().code,
            "collector_storage_identity_mismatch"
        );
        let config = store.config.clone();
        let key = store.key.clone();
        drop(store);
        std::fs::remove_file(data.join("paycom/paycom.sqlite")).unwrap();
        let store = Store::open(config, key).unwrap();
        assert!(store.collector(&id, Provider::Paycom).is_err());
        assert!(!data.join("paycom/paycom.sqlite").exists());
        assert!(Provider::from_job_kind("../../unknown.collect").is_err());
        assert!(store.collector("../../escape", Provider::Paycom).is_err());
    }
}
