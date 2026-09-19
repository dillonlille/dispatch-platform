use super::{Db, Kind, identifier, key_file, migrate, private_dir, private_file, s};
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
        let store = Self {
            platform: Db::create(
                &config.platform().join("accounts.sqlite"),
                Kind::Platform,
                "",
            )?,
            jobs: Db::create(
                &config.environment_root().join("jobs.sqlite"),
                Kind::Jobs,
                "",
            )?,
            config,
            key,
            dsp_cache: std::cell::RefCell::new(Vec::new()),
        };
        crate::roles::backfill(&store.platform)?;
        for row in store.platform.all(
            "SELECT id FROM dsps WHERE status IN ('active','suspended')",
            [],
        )? {
            let id = s(&row, "id");
            migrate(&*store.dsp(id)?, Kind::Dsp)?;
            store.open_collectors(id)?;
            store.initialize_schedules(id)?;
        }
        Ok(store)
    }
    pub fn open(config: Config, key: Vec<u8>) -> Result<Self> {
        Ok(Self {
            platform: Db::open(&config.platform().join("accounts.sqlite"), Kind::Platform)?,
            jobs: Db::open(&config.environment_root().join("jobs.sqlite"), Kind::Jobs)?,
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
        self.cached_database(&path, Kind::Dsp)
    }
    pub(crate) fn cached_database(&self, path: &Path, kind: Kind) -> Result<DspLease<'_>> {
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
            None => Db::open(path, kind)?,
        };
        Ok(DspLease {
            id: id.into_owned(),
            db: Some(db),
            cache: &self.dsp_cache,
        })
    }
    pub fn initialize_dsp(&self, id: &str) -> Result<Db> {
        for area in ["data", "config", "state", "secrets"] {
            self.area(id, area)?;
        }
        Db::create(
            &self.area(id, "data")?.join("dispatch.sqlite"),
            Kind::Dsp,
            "",
        )
    }
}
