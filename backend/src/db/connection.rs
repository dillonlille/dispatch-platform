use super::{
    Kind, migrations, private_file,
    row::{FromRow, Row},
};
use crate::{Result, ensure};
use rusqlite::{Connection, Params, types::ValueRef};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn row_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut out = serde_json::Map::new();
    for i in 0..row.as_ref().column_count() {
        let name = row.as_ref().column_name(i)?;
        let value = match row.get_ref(i)? {
            ValueRef::Null | ValueRef::Blob(_) => Value::Null,
            ValueRef::Integer(n) => json!(n),
            ValueRef::Real(n) => json!(n),
            ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
        };
        out.insert(name.to_owned(), value);
    }
    Ok(Value::Object(out))
}
pub struct Db(pub Connection);
impl Db {
    /// Opens an existing database. Its schema is left alone: requests take this path.
    pub(crate) fn open(file: &Path, kind: Kind) -> Result<Self> {
        Self::connect(file, kind, false)
    }
    /// Startup and provisioning: creates the database when it is missing, then
    /// applies the migrations it lacks. `seed` holds the rows a new database needs
    /// and commits together with its schema, so no reader sees one without them.
    pub(crate) fn create(file: &Path, kind: Kind, seed: &str) -> Result<Self> {
        let db = Self::connect(file, kind, true)?;
        if db.version()? == 0 {
            let tx = migrations::immediate(&db)?;
            // Another connection may have created it while this one waited.
            if db.version()? == 0 {
                migrations::apply(&db, kind.name(), kind.migrations())?;
                tx.execute_batch(seed)?;
                tx.pragma_update(None, "user_version", kind.version())?;
            }
            tx.commit()?;
        }
        migrations::migrate(&db, kind)?;
        Ok(db)
    }
    fn version(&self) -> Result<i64> {
        Ok(self.0.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }
    fn connect(file: &Path, kind: Kind, create: bool) -> Result<Self> {
        private_file(file, create)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            private_file(&PathBuf::from(format!("{}{suffix}", file.display())), false)?;
        }
        let db = Connection::open_with_flags(
            file,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.create_collation("dispatch_unicode", crate::workforce::compare)?;
        let flags = rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC;
        db.create_scalar_function("dispatch_name", 2, flags, |ctx| {
            Ok(crate::workforce::display_name(
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
        let db = Self(db);
        let current = db.version()?;
        ensure(
            (current == 0 && create) || current == kind.version(),
            "incompatible_database",
            503,
        )?;
        db.0.execute_batch("PRAGMA foreign_keys=ON;")?;
        // Moving a new database to WAL takes a lock that ignores the busy timeout,
        // so connections racing to create one retry. Afterwards this changes nothing.
        let began = std::time::Instant::now();
        loop {
            match db.0.execute_batch("PRAGMA journal_mode=WAL;") {
                Err(error)
                    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DatabaseBusy)
                        && began.elapsed() < Duration::from_secs(5) =>
                {
                    std::thread::sleep(Duration::from_millis(5))
                }
                result => break result?,
            }
        }
        db.0.execute_batch("PRAGMA synchronous=FULL;")?;
        Ok(db)
    }
    pub fn exec(&self, sql: &str, p: impl Params) -> Result<usize> {
        Ok(self.0.prepare_cached(sql)?.execute(p)?)
    }
    pub fn all(&self, sql: &str, p: impl Params) -> Result<Vec<Value>> {
        let mut stmt = self.0.prepare_cached(sql)?;
        Ok(stmt
            .query_map(p, row_json)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn one(&self, sql: &str, p: impl Params) -> Result<Option<Value>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .0
            .prepare_cached(sql)?
            .query_row(p, row_json)
            .optional()?)
    }
    /// Every row, read into `T`. A column `T` needs that the query lacks is an error.
    pub fn query_as<T: FromRow>(&self, sql: &str, p: impl Params) -> Result<Vec<T>> {
        let mut stmt = self.0.prepare_cached(sql)?;
        let mut rows = stmt.query(p)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(T::from_row(&Row(row))?);
        }
        Ok(out)
    }
    pub fn one_as<T: FromRow>(&self, sql: &str, p: impl Params) -> Result<Option<T>> {
        let mut stmt = self.0.prepare_cached(sql)?;
        let mut rows = stmt.query(p)?;
        rows.next()?.map(|row| T::from_row(&Row(row))).transpose()
    }
    /// The single number a `SELECT count(*) ...` answers with.
    pub fn count(&self, sql: &str, p: impl Params) -> Result<i64> {
        Ok(self.0.prepare_cached(sql)?.query_row(p, |row| row.get(0))?)
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
        self.exec(
            "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE \
            SET value=excluded.value",
            [key, &value.to_string()],
        )?;
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
