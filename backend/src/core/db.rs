use super::{Result, config::Config, crypto, ensure};
use rusqlite::{Connection, Params, types::ValueRef};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
pub fn private_dir(path: &Path) -> Result<PathBuf> {
    ensure(path.is_absolute(), "unsafe_storage_path", 500)?;
    let mut cursor = PathBuf::from("/");
    for part in path.components().skip(1) {
        ensure(
            matches!(part, std::path::Component::Normal(_)),
            "unsafe_storage_path",
            500,
        )?;
        cursor.push(part);
        if !cursor.try_exists()? {
            fs::DirBuilder::new().mode(0o700).create(&cursor)?;
        }
        let stat = fs::symlink_metadata(&cursor)?;
        ensure(
            stat.is_dir() && !stat.file_type().is_symlink(),
            "unsafe_storage_path",
            500,
        )?;
    }
    let stat = fs::metadata(path)?;
    ensure(
        stat.uid() == unsafe { libc::geteuid() } && stat.mode() & 0o077 == 0,
        "private_storage_permissions_required",
        500,
    )?;
    Ok(path.into())
}
pub fn private_file(path: &Path, create: bool) -> Result<()> {
    private_dir(
        path.parent()
            .ok_or_else(|| super::Error::new("unsafe_storage_path", 500))?,
    )?;
    if create {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
    }
    match fs::symlink_metadata(path) {
        Ok(s) => ensure(
            s.is_file()
                && !s.file_type().is_symlink()
                && s.nlink() == 1
                && s.uid() == unsafe { libc::geteuid() }
                && s.mode() & 0o077 == 0,
            "unsafe_storage_file",
            500,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    private_file(path, false)?;
    let temp = path.with_extension(crypto::id("tmp")?);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn key_file(path: &Path) -> Result<Vec<u8>> {
    private_file(path, false)?;
    if !path.try_exists()? {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(&crypto::random::<32>()?)?;
        f.sync_all()?;
    }
    let key = fs::read(path)?;
    ensure(key.len() == 32, "invalid_key", 500)?;
    Ok(key)
}
pub fn identifier(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|s| {
        s.len() == 32
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn iso() -> String {
    at(now())
}
pub fn at(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub struct Db(pub Connection);
impl Db {
    fn open(file: &Path, schema: &str, version: i64, initialize: bool) -> Result<Self> {
        private_file(file, initialize)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            private_file(&PathBuf::from(format!("{}{suffix}", file.display())), false)?;
        }
        let db = Connection::open_with_flags(
            file,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.create_collation("dispatch_unicode", super::workforce::compare)?;
        let flags = rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC;
        db.create_scalar_function("dispatch_name", 2, flags, |ctx| {
            Ok(super::workforce::display_name(
                &ctx.get::<String>(0)?,
                &ctx.get::<String>(1)?,
            ))
        })?;
        db.create_scalar_function("dispatch_lower", 1, flags, |ctx| {
            Ok(ctx.get::<String>(0)?.to_lowercase())
        })?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.set_prepared_statement_cache_capacity(32);
        db.pragma_update(None, "cache_size", -512)?;
        let current: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure(
            (current == 0 && initialize) || current == version,
            "incompatible_database",
            503,
        )?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        if current == 0 && initialize {
            let tx = db.unchecked_transaction()?;
            tx.execute_batch(schema)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        } else {
            ensure(current == version, "incompatible_database", 503)?;
        }
        Ok(Self(db))
    }
    pub fn exec(&self, sql: &str, p: impl Params) -> Result<usize> {
        Ok(self.0.prepare_cached(sql)?.execute(p)?)
    }
    pub fn all(&self, sql: &str, p: impl Params) -> Result<Vec<Value>> {
        let mut stmt = self.0.prepare_cached(sql)?;
        let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        let rows = stmt
            .query_map(p, |row| {
                let mut out = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let value = match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        ValueRef::Blob(_) => Value::Null,
                    };
                    out.insert(name.clone(), value);
                }
                Ok(Value::Object(out))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn one(&self, sql: &str, p: impl Params) -> Result<Option<Value>> {
        Ok(self.all(sql, p)?.into_iter().next())
    }
    pub fn transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let tx = self.0.unchecked_transaction()?;
        let result = f()?;
        tx.commit()?;
        Ok(result)
    }
    pub fn setting(&self, key: &str, default: Value) -> Result<Value> {
        match self.one("SELECT value FROM settings WHERE key=?", [key])? {
            Some(v) => Ok(serde_json::from_str(s(&v, "value"))?),
            None => Ok(default),
        }
    }
    pub fn set(&self, key: &str, value: &Value) -> Result<()> {
        self.exec("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,&value.to_string()])?;
        Ok(())
    }
}
pub fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn n(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or(0)
}
pub fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or_else(|| n(value, key) != 0)
}
pub fn boolean(value: &mut Value, keys: &[&str]) {
    for key in keys {
        value[*key] = json!(flag(value, key));
    }
}
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
        Ok(Self {
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
        })
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
        private_file(&path, false)?;
        let cached = {
            let mut cache = self.dsp_cache.borrow_mut();
            cache
                .iter()
                .position(|(key, _)| key == id)
                .map(|index| cache.remove(index).1)
        };
        let db = match cached {
            Some(db) => db,
            None => Db::open(&path, "", 1, false)?,
        };
        Ok(DspLease {
            id: id.into(),
            db: Some(db),
            cache: &self.dsp_cache,
        })
    }
    pub fn initialize_dsp(&self, id: &str) -> Result<Db> {
        for area in ["data", "config", "state", "secrets"] {
            self.area(id, area)?;
        }
        Db::open(
            &self.area(id, "data")?.join("dispatch.sqlite"),
            include_str!("dspSchema.sql"),
            1,
            true,
        )
    }
    pub fn audit(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
    ) -> Result<()> {
        self.platform.exec(
            "INSERT INTO audit(at,actor_id,dsp_id,action,detail) VALUES (?,?,?,?,?)",
            rusqlite::params![iso(), actor, dsp, action, detail],
        )?;
        Ok(())
    }
    pub fn audits(&self, dsp: Option<&str>, limit: i64) -> Result<Value> {
        Ok(json!(self.platform.all("SELECT a.id,a.at,a.actor_id actorId,COALESCE(u.first_name||' '||u.last_name,'System') actorName,a.dsp_id dspId,d.name dspName,a.action,a.detail FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN dsps d ON d.id=a.dsp_id WHERE (? IS NULL OR a.dsp_id=?) ORDER BY a.id DESC LIMIT ?",rusqlite::params![dsp,dsp,limit])?))
    }
}
