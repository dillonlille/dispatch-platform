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
        // SQLite removes its -wal, -shm and -journal files when a connection closes.
        // An lstat racing that unlink can still succeed and report no links; the
        // file is already gone, which is the same as not found.
        Ok(s) if s.nlink() == 0 => Ok(()),
        Ok(s) => {
            let safe = s.is_file()
                && !s.file_type().is_symlink()
                && s.nlink() == 1
                && s.uid() == unsafe { libc::geteuid() }
                && s.mode() & 0o077 == 0;
            if !safe {
                super::observability::event(
                    "error",
                    "storage.file_rejected",
                    json!({
                        "links":s.nlink(), "mode":s.mode() & 0o777,
                        "ownerMatches":s.uid() == unsafe { libc::geteuid() },
                        "regular":s.is_file(), "symlink":s.file_type().is_symlink(),
                        "sqliteSidecar":path.to_string_lossy().ends_with("-wal") || path.to_string_lossy().ends_with("-shm") || path.to_string_lossy().ends_with("-journal")
                    }),
                );
            }
            ensure(safe, "unsafe_storage_file", 500)
        }
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
    pub(crate) fn open(file: &Path, schema: &str, version: i64, initialize: bool) -> Result<Self> {
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
// A nullable, additive column keeps the version 3 platform schema readable by
// the previous Rust release. It names the actor once their account is deleted.
fn migrate_audit(db: &Db) -> Result<()> {
    let columns = db.all("PRAGMA table_info(audit)", [])?;
    if !columns.iter().any(|c| s(c, "name") == "actor_name") {
        db.0.execute_batch("ALTER TABLE audit ADD COLUMN actor_name TEXT")?;
    }
    // Who or what an event touched, and the values it changed, as JSON.
    if !columns.iter().any(|c| s(c, "name") == "data") {
        db.0.execute_batch("ALTER TABLE audit ADD COLUMN data TEXT")?;
    }
    // Set when a platform owner acted in a DSP that shows Platform support.
    if !columns.iter().any(|c| s(c, "name") == "shown") {
        db.0.execute_batch("ALTER TABLE audit ADD COLUMN shown INTEGER")?;
    }
    Ok(())
}
const EXPORT_LIMIT: i64 = 50_000;
const VISIT_WINDOW: i64 = 30 * 60 * 1000;
// Activity older than a year is removed by the collector's periodic cleanup.
const AUDIT_RETENTION: i64 = 365 * 24 * 60 * 60 * 1000;
// Managing a DSP from the platform is never part of that DSP's own log.
const PLATFORM_ONLY: [&str; 8] = [
    "dsp.created",
    "dsp.removed",
    "dsp.restored",
    "dsp.suspended",
    "dsp.resumed",
    "dsp.support_visibility_changed",
    "diagnostics.fixtures_loaded",
    "development.fixtures_loaded",
];
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
        super::roles::migrate(&store.platform)?;
        migrate_audit(&store.platform)?;
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
    pub fn audit(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
    ) -> Result<()> {
        self.audit_with(actor, dsp, action, detail, None, &[])
    }
    // Names are stored as text so the event still reads after its subject is deleted.
    pub fn audit_with(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
        target: Option<&str>,
        changes: &[AuditChange],
    ) -> Result<()> {
        self.audit_ref(actor, dsp, action, detail, target, changes, None)
    }
    // A reference names the record an event is about, so the log can gather
    // everything involving it even after a rename.
    #[allow(clippy::too_many_arguments)]
    pub fn audit_ref(
        &self,
        actor: Option<&str>,
        dsp: Option<&str>,
        action: &str,
        detail: &str,
        target: Option<&str>,
        changes: &[AuditChange],
        reference: Option<(&str, &str)>,
    ) -> Result<()> {
        let data = (target.is_some() || !changes.is_empty() || reference.is_some()).then(|| {
            json!({"target":target,"ref":reference.map(|(kind,id)|json!({"kind":kind,"id":id})),"changes":changes.iter().map(|(field,from,to)|json!({"field":field,"from":from,"to":to})).collect::<Vec<_>>()}).to_string()
        });
        let shown = self.shown(actor, dsp, action)?;
        self.platform.exec(
            "INSERT INTO audit(at,actor_id,dsp_id,action,detail,data,shown) VALUES (?,?,?,?,?,?,?)",
            rusqlite::params![iso(), actor, dsp, action, detail, data, shown.then_some(1)],
        )?;
        Ok(())
    }
    // Decided as the event is written, so a visit made while hidden stays hidden.
    fn shown(&self, actor: Option<&str>, dsp: Option<&str>, action: &str) -> Result<bool> {
        Ok(match (actor, dsp) {
            (Some(actor), Some(dsp)) if !PLATFORM_ONLY.contains(&action) => {
                self.platform_owner(actor)? && self.support_visible(dsp)
            }
            _ => false,
        })
    }
    // Opening a DSP happens on every load; one entry per half hour says as much.
    // A hidden visit does not stand in for one the DSP would now be shown.
    pub fn audit_visit(&self, actor: &str, dsp: &str, action: &str, detail: &str) -> Result<()> {
        let shown = self.shown(Some(actor), Some(dsp), action)?;
        let recent = self.platform.one(
            "SELECT 1 FROM audit WHERE actor_id=? AND dsp_id=? AND action=? AND detail=? AND at>=? AND COALESCE(shown,0)=? LIMIT 1",
            rusqlite::params![actor, dsp, action, detail, at(now() - VISIT_WINDOW), shown],
        )?;
        if recent.is_some() {
            return Ok(());
        }
        self.audit(Some(actor), Some(dsp), action, detail)
    }
    // Taking a copy of everyone's activity is itself recorded, after the copy is
    // read so an export never lists itself.
    pub fn audit_export(&self, actor: &str, query: AuditQuery) -> Result<Value> {
        let page = self.audit_page(&AuditQuery {
            before: 0,
            limit: EXPORT_LIMIT,
            ..query
        })?;
        let rows = page["events"].as_array().map_or(0, Vec::len);
        let scope = if query.within.is_empty() {
            query.dsp
        } else {
            Some(query.within)
        };
        self.audit(Some(actor), scope, "audit.exported", &rows.to_string())?;
        Ok(page)
    }
    pub fn prune_audit(&self) -> Result<usize> {
        self.platform.exec(
            "DELETE FROM audit WHERE at<?",
            [at(now() - AUDIT_RETENTION)],
        )
    }
    pub fn platform_owner(&self, user: &str) -> Result<bool> {
        Ok(self
            .platform
            .one(
                "SELECT 1 FROM users WHERE id=? AND platform_owner=1",
                [user],
            )?
            .is_some())
    }
    pub fn support_visible(&self, dsp: &str) -> bool {
        self.profile(dsp)
            .is_ok_and(|profile| flag(&profile, "supportVisible"))
    }
    // A DSP's log lists its members' and the system's actions. A platform owner's
    // appear only where the DSP shows Platform support, and never under their name.
    pub fn audit_page(&self, query: &AuditQuery) -> Result<Value> {
        // Inside a DSP a platform owner is only ever "Platform support".
        const SUPPORT: &str = "(?1 IS NOT NULL AND COALESCE(u.platform_owner,0)=1)";
        const FROM: &str = "FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN dsps d ON d.id=a.dsp_id WHERE (?1 IS NULL OR (a.dsp_id=?1 AND (COALESCE(u.platform_owner,0)=0 OR a.shown=1)))";
        let name = format!(
            "CASE WHEN {SUPPORT} THEN 'Platform support' ELSE COALESCE(u.first_name||' '||u.last_name,a.actor_name,'System') END"
        );
        let actor = format!(
            "CASE WHEN {SUPPORT} THEN 'support' ELSE COALESCE(a.actor_id,CASE WHEN a.actor_name IS NULL THEN 'system' ELSE 'name:'||a.actor_name END) END"
        );
        const AREA: &str = "CASE WHEN a.action LIKE 'member.%' OR a.action LIKE 'invitation.%' THEN 'team' WHEN a.action LIKE 'role.%' THEN 'roles' WHEN a.action LIKE 'collection.%' OR a.action LIKE 'cortex.collection.%' OR a.action LIKE 'meal_breaks.%' THEN 'collections' WHEN a.action LIKE 'schedule.%' THEN 'schedules' WHEN a.action LIKE 'connection.%' THEN 'connections' WHEN a.action IN ('dsp.view_opened','dsp.owner_view_opened') THEN CASE WHEN ?1 IS NULL THEN 'access' ELSE 'team' END WHEN a.action LIKE 'account.%' THEN 'access' WHEN a.action IN ('dsp.created','dsp.removed','dsp.restored','dsp.suspended','dsp.resumed') THEN 'dsps' ELSE 'settings' END";
        const FAILED: &str = "a.action LIKE '%.failed'";
        let filters = format!(
            "{FROM} AND (?2='' OR a.at>=?2) AND (?3='' OR {actor}=?3) AND (?4='' OR a.action LIKE ?4 ESCAPE '\\' OR a.detail LIKE ?4 ESCAPE '\\' OR COALESCE(a.data,'') LIKE ?4 ESCAPE '\\' OR {name} LIKE ?4 ESCAPE '\\' OR COALESCE(d.name,'') LIKE ?4 ESCAPE '\\') AND (?5='' OR a.dsp_id=?5) AND ((?6='' AND ?7='') OR (?6<>'' AND json_extract(a.data,'$.ref.kind')||':'||json_extract(a.data,'$.ref.id')=?6) OR (?7<>'' AND json_extract(a.data,'$.target')=?7))"
        );
        let area = format!("(?8='' OR (?8='failures' AND {FAILED}) OR {AREA}=?8)");
        let search = if query.q.is_empty() {
            String::new()
        } else {
            format!(
                "%{}%",
                query
                    .q
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        };
        let mut events = self.platform.all(&format!("SELECT a.id,a.at,CASE WHEN {SUPPORT} THEN NULL ELSE a.actor_id END actorId,{name} actorName,a.dsp_id dspId,d.name dspName,a.action,a.detail,a.data,{AREA} area {filters} AND {area} AND (?9=0 OR a.id<?9) ORDER BY a.id DESC LIMIT ?10"),rusqlite::params![query.dsp,query.from,query.actor,search,query.within,query.subject,query.named,query.area,query.before,query.limit])?;
        for event in &mut events {
            let data = event["data"]
                .as_str()
                .and_then(|data| serde_json::from_str::<Value>(data).ok())
                .unwrap_or(Value::Null);
            event["target"] = data["target"].clone();
            event["ref"] = data["ref"].clone();
            event["changes"] = if data["changes"].is_array() {
                data["changes"].clone()
            } else {
                json!([])
            };
            event.as_object_mut().unwrap().remove("data");
        }
        let total = self.platform.one(
            &format!("SELECT count(*) count {filters} AND {area}"),
            rusqlite::params![
                query.dsp,
                query.from,
                query.actor,
                search,
                query.within,
                query.subject,
                query.named,
                query.area
            ],
        )?;
        let mut counts = serde_json::Map::new();
        let mut failures = 0;
        for row in self.platform.all(
            &format!(
                "SELECT {AREA} area,count(*) count,sum({FAILED}) failures {filters} GROUP BY 1"
            ),
            rusqlite::params![
                query.dsp,
                query.from,
                query.actor,
                search,
                query.within,
                query.subject,
                query.named
            ],
        )? {
            counts.insert(s(&row, "area").to_owned(), json!(n(&row, "count")));
            failures += n(&row, "failures");
        }
        counts.insert("failures".into(), json!(failures));
        let actors = self.platform.all(
            &format!("SELECT DISTINCT {actor} id,{name} name {FROM} ORDER BY 2"),
            rusqlite::params![query.dsp],
        )?;
        // The platform's log spans every DSP, so it can be narrowed to one.
        let dsps = if query.dsp.is_none() {
            self.platform.all("SELECT DISTINCT d.id,d.name FROM audit a JOIN dsps d ON d.id=a.dsp_id ORDER BY d.name", [])?
        } else {
            Vec::new()
        };
        Ok(
            json!({"events":events,"total":n(&total.unwrap(),"count"),"counts":counts,"actors":actors,"dsps":dsps}),
        )
    }
}
// A changed field with its previous and new value; either side may be absent.
pub type AuditChange = (&'static str, Option<String>, Option<String>);
pub struct AuditQuery<'a> {
    pub dsp: Option<&'a str>,
    pub area: &'a str,
    pub actor: &'a str,
    pub q: &'a str,
    pub from: &'a str,
    pub before: i64,
    pub limit: i64,
    // One DSP within the platform's log.
    pub within: &'a str,
    // Events about one subject: its "kind:id" reference, or the name older events kept.
    pub subject: &'a str,
    pub named: &'a str,
}
impl Default for AuditQuery<'_> {
    fn default() -> Self {
        Self {
            dsp: None,
            area: "",
            actor: "",
            q: "",
            from: "",
            before: 0,
            limit: 50,
            within: "",
            subject: "",
            named: "",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[test]
    fn a_file_deleted_during_the_check_is_absent_but_hard_links_stay_unsafe() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.path().join("dispatch.sqlite-wal");
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !stop.load(Ordering::Relaxed) {
                    drop(
                        OpenOptions::new()
                            .write(true)
                            .create(true)
                            .truncate(true)
                            .mode(0o600)
                            .open(&path),
                    );
                    let _ = fs::remove_file(&path);
                }
            });
            // Stop the writer before asserting so a failure cannot leave it running.
            let began = std::time::Instant::now();
            let mut failed = None;
            while failed.is_none() && began.elapsed() < Duration::from_secs(2) {
                failed = private_file(&path, false).err();
            }
            stop.store(true, Ordering::Relaxed);
            assert!(failed.is_none(), "a deleted file was reported unsafe");
        });
        fs::write(&path, "").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        private_file(&path, false).unwrap();
        fs::hard_link(&path, root.path().join("link")).unwrap();
        assert!(private_file(&path, false).is_err());
    }
}
