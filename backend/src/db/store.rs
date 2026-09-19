use super::{Db, identifier, key_file, private_dir, private_file, s};
use crate::{Result, config::Config, ensure};
use std::path::{Path, PathBuf};
pub struct DspLease<'a> {
    id: String,
    db: Option<Db>,
    cache: &'a std::cell::RefCell<Vec<(String, Db)>>,
}
impl std::ops::Deref for DspLease<'_> {
    type Target = Db;
    fn deref(&self) -> &Db {
        self.db.as_ref().expect("database lease")
    }
}
impl Drop for DspLease<'_> {
    fn drop(&mut self) {
        if let Some(db) = self.db.take() {
            let mut cache = self.cache.borrow_mut();
            if cache.len() >= 4 {
                cache.remove(0);
            }
            cache.push((self.id.clone(), db));
        }
    }
}

pub struct Store {
    pub config: Config,
    pub platform: Db,
    pub jobs: Db,
    pub key: Vec<u8>,
    dsp_cache: std::cell::RefCell<Vec<(String, Db)>>,
}
impl Store {
    pub fn initialize(config: Config) -> Result<Self> {
        private_dir(&config.root)?;
        private_dir(&config.root.join("config"))?;
        private_dir(&config.root.join("data"))?;
        private_dir(&config.platform())?;
        private_dir(&config.environment_root())?;
        private_dir(&config.root.join("dsps"))?;
        let key = key_file(&config.platform().join("platform.key"))?;
        let jobs = Db::open(
            &config.environment_root().join("jobs.sqlite"),
            include_str!("jobSchema.sql"),
            1,
            true,
        )?;
        // Additive tables retain compatibility with the previous Rust release.
        jobs.0.execute_batch(include_str!("jobMetricsSchema.sql"))?;
        let store = Self {
            platform: Db::open(
                &config.platform().join("accounts.sqlite"),
                include_str!("platformSchema.sql"),
                3,
                true,
            )?,
            jobs,
            config,
            key,
            dsp_cache: std::cell::RefCell::new(Vec::new()),
        };
        crate::roles::migrate(&store.platform)?;
        crate::audit::migrate_audit(&store.platform)?;
        store
            .platform
            .0
            .execute_batch(include_str!("platformIndexes.sql"))?;
        store
            .jobs
            .0
            .execute_batch("CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC)")?;
        for row in store.platform.all(
            "SELECT id FROM dsps WHERE status IN ('active','suspended')",
            [],
        )? {
            let id = s(&row, "id");
            store.open_collectors(id)?;
            store.initialize_schedules(id)?;
        }
        Ok(store)
    }
    pub fn open(config: Config, key: Vec<u8>) -> Result<Self> {
        Ok(Self {
            platform: Db::open(&config.platform().join("accounts.sqlite"), "", 3, false)?,
            jobs: Db::open(&config.environment_root().join("jobs.sqlite"), "", 1, false)?,
            config,
            key,
            dsp_cache: std::cell::RefCell::new(Vec::new()),
        })
    }
    pub fn area(&self, dsp: &str, area: &str) -> Result<PathBuf> {
        ensure(identifier(dsp, "dsp_"), "invalid_dsp_id", 400)?;
        ensure(
            ["data", "config", "state", "secrets"].contains(&area),
            "invalid_area",
            400,
        )?;
        let root = self.config.root.join("dsps").join(dsp);
        private_dir(&root)?;
        private_dir(&root.join(area))
    }
    pub fn dsp(&self, id: &str) -> Result<DspLease<'_>> {
        let path = self.area(id, "data")?.join("dispatch.sqlite");
        self.cached_database(&path, 1)
    }
    pub(crate) fn cached_database(&self, path: &Path, version: i64) -> Result<DspLease<'_>> {
        private_file(path, false)?;
        ensure(path.is_file(), "storage_file_missing", 503)?;
        let id = path.to_string_lossy();
        let cached = {
            let mut cache = self.dsp_cache.borrow_mut();
            cache
                .iter()
                .position(|(key, _)| key == &id)
                .map(|index| cache.remove(index).1)
        };
        let db = match cached {
            Some(db) => db,
            None => Db::open(path, "", version, false)?,
        };
        Ok(DspLease {
            id: id.into_owned(),
            db: Some(db),
            cache: &self.dsp_cache,
        })
    }
    // Core settings are separate from provider-owned data from initial provisioning.
    pub fn initialize_dsp(&self, id: &str) -> Result<Db> {
        for area in ["data", "config", "state", "secrets"] {
            self.area(id, area)?;
        }
        Db::open(
            &self.area(id, "data")?.join("dispatch.sqlite"),
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            1,
            true,
        )
    }
}
